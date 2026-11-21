import AVFAudio
import Foundation
import Speech

@main
struct StickSpeech {
    static func main() async {
        do {
            try await run()
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }

    static func run() async throws {
        let args = CommandLine.arguments.dropFirst()
        guard args.count == 1, let source = args.first else {
            throw failure("Usage: StickSpeech --check | --prepare | recording.wav")
        }
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "zh_CN")) else {
            throw failure("On-device Chinese transcription is unavailable on this Mac")
        }
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        if source == "--prepare" {
            if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await install.downloadAndInstall()
            }
        }
        let status = await AssetInventory.status(forModules: [transcriber])
        if source == "--check" || source == "--prepare" {
            print("\(locale.identifier): \(status)")
            return
        }
        guard status == .installed else {
            throw failure("Chinese language model is unavailable. Run StickSpeech --prepare.")
        }
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: source))
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        async let text: String = collect(transcriber)
        do {
            try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
            print(try await text)
        } catch {
            await analyzer.cancelAndFinishNow()
            throw error
        }
    }

    static func collect(_ transcriber: SpeechTranscriber) async throws -> String {
        var text = ""
        for try await result in transcriber.results where result.isFinal {
            text += String(result.text.characters)
        }
        return text
    }

    static func failure(_ text: String) -> NSError {
        NSError(domain: "StickSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
}
