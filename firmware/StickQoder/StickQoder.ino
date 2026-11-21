#include <M5Unified.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <atomic>

namespace {
constexpr int VibratorPin = -1;  // Set to GPIO 9 only with a suitable external driver.
constexpr int SampleRate = 16000;
constexpr int Chunk = 1600;
constexpr int MaxSamples = SampleRate * 8;
constexpr int WavHeader = 44;
constexpr uint32_t OfflineMs = 5500;
constexpr char Protocol[] = "STICK-QODER/1";

enum Command { Poll, Pause, Resume, Send, Discard, Upload };
enum Capture { Quiet, Warmup, Recording, Uploading };
struct Request { Command command; uint32_t target; size_t bytes; };
struct Response { Command command; int status; char line[768]; };
QueueHandle_t requests, responses;
Preferences preferences;
M5Canvas canvas(&M5.Display);
String ssid, password, endpoint, token;
String state = "UNPAIRED", detail = "USB pairing required", transcript, toast;
uint32_t turnId = 0, draftId = 0, lastOK = 0, nextPoll = 0, toastUntil = 0;
uint32_t micReadyAt = 0, micDeadline = 0, speakerReadyAt = 0, alertAt = 0;
uint32_t alertId = 0, queuedAt = 0;
uint32_t nextWiFiRetry = 0;
String alert;
String serialLine;
bool serialOverflow = false, dirty = true, linked = false, hadLink = false;
bool paired = false, pending = false, voiceAllowed = false, captureStopping = false;
bool speakerReady = false, motorOn = false;
bool wifiWasConnected = false;
bool scanPending = false;
Capture capture = Quiet;
Command inFlight = Poll;
Request queuedAction{Poll, 0, 0};
uint8_t* wav = nullptr;
int queuedSamples = 0;
std::atomic<int> capturedSamples{0};
std::atomic<int> wifiDisconnectReason{0};
std::atomic<int> wifiFailureReason{0};
int lastHttpStatus = 0;

bool due(uint32_t now, uint32_t deadline) {
  return int32_t(now - deadline) >= 0;
}

void notifyUser(const String& message) {
  toast = message;
  toastUntil = millis() + 2400;
  dirty = true;
}

void drawWrapped(const String& value, int x, int y, int lines) {
  String line;
  for (unsigned i = 0; i < value.length() && lines > 0;) {
    unsigned char first = value[i];
    unsigned count = first < 0x80 ? 1 : first < 0xE0 ? 2 : first < 0xF0 ? 3 : 4;
    String glyph = value.substring(i, i + count);
    if (line.length() && canvas.textWidth(line + glyph) > canvas.width() - 2 * x) {
      canvas.drawString(line, x, y);
      if (--lines == 0) return;
      line = "";
      y += 13;
    }
    line += glyph;
    i += count;
  }
  if (lines > 0) canvas.drawString(line, x, y);
}

void draw() {
  dirty = false;
  const uint16_t ink = 0xEF7D, muted = 0x9CF3;
  uint16_t accent = 0x5EFC;
  String title = state, body = detail, footer = "A Pause/Go   Hold B Talk";
  if (!paired) {
    title = "PAIR VIA USB";
    body = "Run pair.mjs on the Mac";
    footer = "Waiting for Wi-Fi settings";
  } else if (!linked) {
    title = WiFi.status() == WL_CONNECTED ? "BRIDGE OFFLINE" : "WI-FI OFFLINE";
    body = hadLink ? "Connection lost. Reconnecting..." : endpoint;
    footer = "Controls unavailable";
    accent = 0xFC65;
  } else if (capture != Quiet) {
    title = capture == Warmup ? "MIC STARTING" : capture == Recording ? "RECORDING" : "UPLOADING";
    body = capture == Warmup ? "Keep holding B. Speak at RECORDING." :
           capture == Recording ? "Release B to transcribe" : "Sending audio to the Mac";
    footer = "";
  } else if (draftId) {
    title = "VOICE PREVIEW";
    body = transcript;
    footer = state == "RUNNING" ? "A Pause   B Discard" :
             state == "PAUSING" ? "Stopping...   B Discard" : "A Send   B Discard";
  } else {
    if (state == "DONE") accent = 0x76EC;
    if (state == "ERROR" || state == "NETWORK ERROR") accent = 0xFC65;
    if (!voiceAllowed) footer = "A Pause/Go   Voice off";
  }
  if (toast.length()) body = toast;
  canvas.fillScreen(0x1107);
  canvas.fillRect(0, 0, canvas.width(), 3, accent);
  canvas.setTextColor(muted);
  canvas.setFont(&fonts::Font2);
  canvas.drawString("QODER / STICK S3", 10, 9);
  canvas.setTextColor(accent);
  canvas.setTextSize(2);
  canvas.drawString(title, 10, 29);
  canvas.setTextSize(1);
  canvas.setFont(&fonts::efontCN_12);
  canvas.setTextColor(ink);
  drawWrapped(body, 10, 61, 4);
  canvas.drawFastHLine(10, 113, canvas.width() - 20, 0x39CB);
  canvas.setFont(&fonts::Font2);
  canvas.setTextColor(muted);
  canvas.drawString(footer, 10, 117);
  canvas.pushSprite(0, 0);
}

void startSpeaker() {
  if (M5.Speaker.begin()) {
    M5.Speaker.setVolume(72);
    speakerReadyAt = millis() + 1050;
    speakerReady = true;
  }
}

void updateAlert(uint32_t now) {
  if (motorOn && due(now, alertAt)) {
    if (VibratorPin >= 0) digitalWrite(VibratorPin, LOW);
    motorOn = false;
  }
  if (!alert.length() || capture == Warmup || capture == Recording) return;
  if (VibratorPin < 0 && (!speakerReady || !due(now, speakerReadyAt))) return;
  const bool success = alert == "DONE";
  const uint32_t duration = success ? 170 : 460;
  if (VibratorPin >= 0) {
    digitalWrite(VibratorPin, HIGH);
    motorOn = true;
    alertAt = now + duration;
  } else {
    M5.Speaker.tone(success ? 1750 : 700, duration);
  }
  alert = "";
}

void exchange(void*) {
  Request request;
  while (xQueueReceive(requests, &request, portMAX_DELAY) == pdTRUE) {
    Response result{};
    result.command = request.command;
    result.status = -1;
    if (WiFi.status() == WL_CONNECTED) {
      WiFiClient wire;
      HTTPClient http;
      const char* route = request.command == Poll ? "/status" :
                          request.command == Upload ? "/voice" : "/action";
      if (http.begin(wire, endpoint + route)) {
        http.setConnectTimeout(1000);
        http.setTimeout(2200);
        http.addHeader("Authorization", "Bearer " + token);
        if (request.command == Poll) {
          result.status = http.GET();
        } else if (request.command == Upload) {
          http.addHeader("Content-Type", "audio/wav");
          result.status = http.POST(wav, request.bytes);
        } else {
          constexpr const char* actions[] = {"", "pause", "resume", "send", "discard"};
          http.addHeader("Content-Type", "text/plain");
          result.status = http.POST(String(actions[request.command]) + "\t" + request.target);
        }
        if (result.status > 0 && http.getSize() > 0 && http.getSize() < int(sizeof(result.line))) {
          http.getString().toCharArray(result.line, sizeof(result.line));
        }
        http.end();
      }
    }
    xQueueSend(responses, &result, portMAX_DELAY);
  }
}

bool sendRequest(Command command, uint32_t target = 0, size_t bytes = 0) {
  Request request{command, target, bytes};
  if (pending || xQueueSend(requests, &request, 0) != pdTRUE) return false;
  pending = true;
  inFlight = command;
  return true;
}

void sendAction(Command command, uint32_t target) {
  if (sendRequest(command, target)) return;
  if (inFlight == Poll && queuedAction.command == Poll) {
    queuedAction = {command, target, 0};
    queuedAt = millis();
  } else {
    notifyUser("Bridge is busy");
  }
}

bool split(const String& line, String* fields, unsigned count) {
  unsigned start = 0;
  for (unsigned i = 0; i + 1 < count; ++i) {
    const int end = line.indexOf('\t', start);
    if (end < 0) return false;
    fields[i] = line.substring(start, end);
    start = end + 1;
  }
  fields[count - 1] = line.substring(start);
  return true;
}

void updateLink(uint32_t now) {
  if (!paired) return;
  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  if (!wifiConnected && !scanPending && due(now, nextWiFiRetry)) {
    nextWiFiRetry = now + 12000;
    WiFi.reconnect();
  }
  if (wifiConnected != wifiWasConnected) {
    wifiWasConnected = wifiConnected;
    dirty = true;
  }
  Response response;
  if (xQueueReceive(responses, &response, 0) == pdTRUE) {
    pending = false;
    lastHttpStatus = response.status;
    if (response.command == Upload) {
      capture = Quiet;
      dirty = true;
    }
    String fields[10];
    if (response.status == 200 && split(response.line, fields, 10) && fields[0] == Protocol) {
      const uint32_t newTurn = strtoul(fields[2].c_str(), nullptr, 10);
      const uint32_t newDraft = strtoul(fields[3].c_str(), nullptr, 10);
      const bool newVoice = fields[4] == "1";
      if (!linked || fields[1] != state || newTurn != turnId || newDraft != draftId ||
          newVoice != voiceAllowed || fields[5] != detail || fields[6] != transcript) dirty = true;
      const uint32_t event = strtoul(fields[8].c_str(), nullptr, 10);
      if (event && event != alertId) {
        alertId = event;
        alert = fields[9];
      }
      state = fields[1];
      turnId = newTurn;
      draftId = newDraft;
      voiceAllowed = newVoice;
      detail = fields[5];
      transcript = fields[6];
      if (fields[7].length()) notifyUser(fields[7]);
      lastOK = now;
      linked = hadLink = true;
    } else if (response.status == 401) {
      if (linked || detail != "Pairing key rejected") dirty = true;
      linked = false;
      detail = "Pairing key rejected";
      notifyUser(detail);
    } else if (response.command != Poll) {
      notifyUser(response.status > 0 && response.line[0] ? response.line : "Request failed. Check bridge.");
    }
    nextPoll = now + 850;
  }
  if (linked && (now - lastOK >= OfflineMs || !wifiConnected)) {
    linked = false;
    dirty = true;
    alert = "OFFLINE";
  }
  if (queuedAction.command != Poll && !pending) {
    if (linked && now - queuedAt < 3000) sendRequest(queuedAction.command, queuedAction.target);
    else notifyUser("Action expired. Press again.");
    queuedAction.command = Poll;
  }
  if (wifiConnected && !pending && due(now, nextPoll)) sendRequest(Poll);
}

void setWavHeader(int samples) {
  const uint32_t dataSize = samples * sizeof(int16_t);
  auto u16 = [](uint8_t* p, uint16_t n) { memcpy(p, &n, sizeof(n)); };
  auto u32 = [](uint8_t* p, uint32_t n) { memcpy(p, &n, sizeof(n)); };
  memcpy(wav, "RIFF", 4);
  u32(wav + 4, dataSize + 36);
  memcpy(wav + 8, "WAVEfmt ", 8);
  u32(wav + 16, 16);
  u16(wav + 20, 1);
  u16(wav + 22, 1);
  u32(wav + 24, SampleRate);
  u32(wav + 28, SampleRate * 2);
  u16(wav + 32, 2);
  u16(wav + 34, 16);
  memcpy(wav + 36, "data", 4);
  u32(wav + 40, dataSize);
}

void beginCapture(uint32_t now) {
  if (!linked || !voiceAllowed || draftId || !wav) {
    notifyUser(!wav ? "Audio buffer unavailable" : "Voice is unavailable");
    return;
  }
  M5.Speaker.end();
  speakerReady = false;
  M5.Mic.setSampleRate(SampleRate);
  capturedSamples.store(0);
  queuedSamples = 0;
  captureStopping = false;
  M5.Mic.setBufferReleaseCallback(nullptr, [](void*, void*, size_t length) {
    capturedSamples.fetch_add(length, std::memory_order_release);
  });
  if (!M5.Mic.begin()) {
    startSpeaker();
    notifyUser("Could not start microphone");
    return;
  }
  micReadyAt = now + 1100;
  micDeadline = micReadyAt + 9000;
  capture = Warmup;
  dirty = true;
}

void updateCapture(uint32_t now) {
  if (capture != Warmup && capture != Recording) return;
  if (capture == Warmup && M5.BtnB.isPressed() && due(now, micReadyAt)) {
    capture = Recording;
    dirty = true;
  }
  if (!M5.BtnB.isPressed() || queuedSamples >= MaxSamples || due(now, micDeadline)) captureStopping = true;
  if (capture == Recording && !captureStopping) {
    const int completed = capturedSamples.load(std::memory_order_acquire);
    if (queuedSamples - completed < Chunk * 2) {
      auto* pcm = reinterpret_cast<int16_t*>(wav + WavHeader);
      if (M5.Mic.record(pcm + queuedSamples, Chunk, SampleRate)) queuedSamples += Chunk;
    }
  }
  if (!captureStopping) return;
  const int completed = capturedSamples.load(std::memory_order_acquire);
  if (completed < queuedSamples && !due(now, micDeadline)) return;
  if (completed >= SampleRate / 2 && linked && pending && !due(now, micDeadline)) return;
  M5.Mic.end();
  startSpeaker();
  capture = Quiet;
  dirty = true;
  if (completed < SampleRate / 2) {
    notifyUser("Hold B until RECORDING, then speak.");
  } else {
    setWavHeader(completed);
    if (linked && sendRequest(Upload, 0, WavHeader + completed * 2)) capture = Uploading;
    else notifyUser("Recording was not sent");
  }
}

void savePairing(const String& networkName, const String& secret, const String& url, const String& key) {
  if (!networkName.length() || networkName.length() > 32 || networkName.indexOf('\t') >= 0 ||
      secret.length() > 63 || !url.startsWith("http://") || url.length() > 100 ||
      key.length() != 48 || key.indexOf('\t') >= 0) {
    Serial.println("INVALID SETTINGS");
    return;
  }
  const String packed = networkName + "\t" + secret + "\t" + url + "\t" + key;
  const bool opened = preferences.begin("stick-qoder", false);
  const bool saved = opened && preferences.putString("pair", packed) > 0;
  if (opened) preferences.end();
  if (saved) {
    Serial.println("PAIR OK");
    Serial.flush();
    delay(350);
    ESP.restart();
  }
  Serial.println("SAVE FAILED");
}

void updateSerial() {
  for (int read = 0; read < 64 && Serial.available(); ++read) {
    const char ch = Serial.read();
    if (ch == '\r') continue;
    if (ch != '\n') {
      if (serialLine.length() < 300) serialLine += ch;
      else serialOverflow = true;
      continue;
    }
    String fields[5];
    if (serialLine == "HELLO") {
      Serial.println(Protocol);
    } else if (serialLine == "NET") {
      Serial.printf("NET paired=%d ssid=%s wifi=%d reason=%d failure=%d ip=%s channel=%d rssi=%d http=%d linked=%d\n",
                    paired, ssid.c_str(), WiFi.status(), wifiDisconnectReason.load(), wifiFailureReason.load(),
                    WiFi.localIP().toString().c_str(),
                    WiFi.channel(), WiFi.RSSI(), lastHttpStatus, linked);
    } else if (serialLine == "NETSCAN" && paired && !scanPending) {
      WiFi.setAutoReconnect(false);
      if (WiFi.status() != WL_CONNECTED) WiFi.disconnect();
      const int count = WiFi.scanNetworks(true);
      scanPending = count == WIFI_SCAN_RUNNING || count >= 0;
      if (!scanPending) {
        WiFi.setAutoReconnect(true);
        Serial.println("NETSCAN scan could not start");
      }
    } else if (!serialOverflow && paired && serialLine.startsWith("PAIRSSID\t")) {
      savePairing(serialLine.substring(9), password, endpoint, token);
    } else if (!serialOverflow && split(serialLine, fields, 5) && fields[0] == "PAIR") {
      savePairing(fields[1], fields[2], fields[3], fields[4]);
    }
    serialOverflow = false;
    serialLine = "";
  }
}

void updateScan() {
  if (!scanPending) return;
  const int count = WiFi.scanComplete();
  if (count == WIFI_SCAN_RUNNING) return;
  int matching = 0;
  for (int index = 0; index < count; ++index) {
    if (WiFi.SSID(index) != ssid) continue;
    ++matching;
    Serial.printf("MATCH channel=%d rssi=%d auth=%d\n",
                  WiFi.channel(index), WiFi.RSSI(index), WiFi.encryptionType(index));
  }
  Serial.printf("NETSCAN found=%d matches=%d\n", count, matching);
  WiFi.scanDelete();
  WiFi.setAutoReconnect(true);
  nextWiFiRetry = millis();
  scanPending = false;
}
}  // namespace

void setup() {
  auto config = M5.config();
  M5.begin(config);
  Serial.begin(115200);
  M5.Mic.end();
  M5.Display.setRotation(1);
  M5.Display.setBrightness(150);
  canvas.setColorDepth(16);
  canvas.createSprite(M5.Display.width(), M5.Display.height());
  canvas.setTextDatum(top_left);
  if (VibratorPin >= 0) {
    pinMode(VibratorPin, OUTPUT);
    digitalWrite(VibratorPin, LOW);
  } else {
    startSpeaker();
  }
  wav = static_cast<uint8_t*>(ps_malloc(WavHeader + MaxSamples * 2));
  String fields[4];
  if (preferences.begin("stick-qoder", true)) {
    paired = split(preferences.getString("pair"), fields, 4);
    preferences.end();
  }
  if (paired) {
    ssid = fields[0];
    password = fields[1];
    endpoint = fields[2];
    token = fields[3];
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
      const int reason = info.wifi_sta_disconnected.reason;
      wifiDisconnectReason.store(reason);
      if (reason != WIFI_REASON_ASSOC_LEAVE && reason != WIFI_REASON_STA_LEAVING) {
        wifiFailureReason.store(reason);
      }
    }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    WiFi.begin(ssid.c_str(), password.c_str());
    nextWiFiRetry = millis() + 12000;
    requests = xQueueCreate(1, sizeof(Request));
    responses = xQueueCreate(1, sizeof(Response));
    xTaskCreate(exchange, "bridge", 8192, nullptr, 1, nullptr);
  }
}

void loop() {
  M5.update();
  const uint32_t now = millis();
  updateSerial();
  updateScan();
  updateLink(now);
  if (capture == Quiet && M5.BtnA.wasClicked()) {
    if (!linked) notifyUser("Bridge unavailable");
    else if (state == "RUNNING") sendAction(Pause, turnId);
    else if (state == "PAUSING") notifyUser("Waiting for Qoder to stop");
    else if (draftId) sendAction(Send, draftId);
    else if (state == "PAUSED" || state == "NETWORK ERROR") sendAction(Resume, turnId);
    else notifyUser("No active task to control");
  }
  if (capture == Quiet && M5.BtnB.wasClicked() && draftId && linked) {
    sendAction(Discard, draftId);
  }
  if (capture == Quiet && M5.BtnB.wasHold()) beginCapture(now);
  updateCapture(now);
  updateAlert(now);
  if (toast.length() && due(now, toastUntil)) {
    toast = "";
    dirty = true;
  }
  if (dirty) draw();
  delay(4);
}
