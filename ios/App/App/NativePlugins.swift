import AVFoundation
import Capacitor
import Foundation
import Security
import Speech

@objc(AppSettingsPlugin)
final class AppSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "AppSettingsPlugin"
    let jsName = "AppSettings"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    private let service = "org.openmemory.mylife.community.settings"
    private let account = "app-settings"

    @objc func load(_ call: CAPPluginCall) {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve(["value": ""])
            return
        }
        guard status == errSecSuccess, let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Unable to read secure settings.")
            return
        }
        call.resolve(["value": value])
    }

    @objc func save(_ call: CAPPluginCall) {
        let value = call.getString("value") ?? ""
        guard let data = value.data(using: .utf8) else {
            call.reject("Unable to encode secure settings.")
            return
        }
        let query = keychainQuery()
        let attributes = [kSecValueData as String: data]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess {
            call.resolve()
            return
        }
        if updated != errSecItemNotFound {
            call.reject("Unable to update secure settings.")
            return
        }
        var newItem = query
        newItem[kSecValueData as String] = data
        newItem[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(newItem as CFDictionary, nil) == errSecSuccess else {
            call.reject("Unable to save secure settings.")
            return
        }
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        let status = SecItemDelete(keychainQuery() as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Unable to clear secure settings.")
        }
    }

    private func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

@objc(RealtimeRecorderPlugin)
final class RealtimeRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "RealtimeRecorderPlugin"
    let jsName = "RealtimeRecorder"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startAsr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitAsr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishAsr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abortAsr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cutSegment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentAmplitude", returnType: CAPPluginReturnPromise),
    ]

    private final class SpeechContext {
        let request: SFSpeechAudioBufferRecognitionRequest
        var task: SFSpeechRecognitionTask?
        var requestId: String?
        var transcript = ""
        var committed = false
        var completed = false

        init(request: SFSpeechAudioBufferRecognitionRequest) {
            self.request = request
        }
    }

    private let audioEngine = AVAudioEngine()
    private let stateLock = NSLock()
    private var activeAudioFile: AVAudioFile?
    private var activeAudioURL: URL?
    private var activeAudioFormat: AVAudioFormat?
    private var segmentFrames: AVAudioFramePosition = 0
    private var currentAmplitude = 0.0
    private var isRecording = false
    private var tapInstalled = false
    private var speechRecognizer: SFSpeechRecognizer?
    private var speechContext: SpeechContext?
    private var speechHasAudio = false

    @objc override func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(["recordAudio": microphonePermissionName()])
    }

    @objc override func requestPermissions(_ call: CAPPluginCall) {
        if AVAudioSession.sharedInstance().recordPermission == .granted {
            call.resolve(["recordAudio": "granted"])
            return
        }
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            call.resolve(["recordAudio": granted ? "granted" : "denied"])
        }
    }

    @objc func startAsr(_ call: CAPPluginCall) {
        guard call.getString("provider") == "apple-speech" else {
            call.reject("Unsupported iPhone speech provider.")
            return
        }
        guard speechContext == nil else {
            call.reject("Speech recognition is already active.")
            return
        }
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                guard status == .authorized else {
                    call.reject("Speech recognition permission was not granted.")
                    return
                }
                let locale = self.speechLocale(call.getString("language") ?? "auto")
                guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
                    call.reject("Speech recognition is not available for this language.")
                    return
                }
                self.speechRecognizer = recognizer
                self.stateLock.lock()
                self.speechHasAudio = false
                self.startSpeechContextLocked()
                self.stateLock.unlock()
                call.resolve()
            }
        }
    }

    @objc func commitAsr(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.stateLock.lock()
            guard let context = self.speechContext else {
                self.stateLock.unlock()
                call.reject("Speech recognition is not active.")
                return
            }
            guard self.speechHasAudio else {
                self.stateLock.unlock()
                call.resolve(["committed": false])
                return
            }
            context.requestId = self.safeIdentifier(call.getString("requestId"))
            context.committed = true
            context.request.endAudio()
            self.speechHasAudio = false
            self.startSpeechContextLocked()
            self.stateLock.unlock()
            call.resolve(["committed": true, "requestId": context.requestId ?? ""])
        }
    }

    @objc func finishAsr(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.stateLock.lock()
            self.speechContext?.task?.cancel()
            self.speechContext?.request.endAudio()
            self.speechContext = nil
            self.speechRecognizer = nil
            self.speechHasAudio = false
            self.stateLock.unlock()
            self.notifyListeners("asrEvent", data: ["type": "finished"])
            call.resolve()
        }
    }

    @objc func abortAsr(_ call: CAPPluginCall) {
        stateLock.lock()
        speechContext?.task?.cancel()
        speechContext?.request.endAudio()
        speechContext = nil
        speechRecognizer = nil
        speechHasAudio = false
        stateLock.unlock()
        call.resolve()
    }

    @objc func startRecording(_ call: CAPPluginCall) {
        guard AVAudioSession.sharedInstance().recordPermission == .granted else {
            call.reject("Microphone permission was not granted.")
            return
        }
        guard !isRecording else {
            call.reject("Recording is already active.")
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw NSError(domain: "MyLifeAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone input format."])
            }

            stateLock.lock()
            do {
                activeAudioFormat = format
                try openNextRecordingLocked(format: format)
                isRecording = true
                currentAmplitude = 0
                stateLock.unlock()
            } catch {
                activeAudioFormat = nil
                isRecording = false
                discardActiveRecordingLocked()
                stateLock.unlock()
                throw error
            }

            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
                self?.receiveAudio(buffer)
            }
            tapInstalled = true
            audioEngine.prepare()
            try audioEngine.start()
            call.resolve()
        } catch {
            stateLock.lock()
            isRecording = false
            discardActiveRecordingLocked()
            stateLock.unlock()
            removeAudioTapIfNeeded()
            call.reject("Unable to start recording.", nil, error)
        }
    }

    @objc func cutSegment(_ call: CAPPluginCall) {
        do {
            stateLock.lock()
            guard isRecording, let format = activeAudioFormat else {
                stateLock.unlock()
                call.reject("No recording is active.")
                return
            }
            let result = try finalizeRecordingLocked(segmentId: call.getString("segmentId"))
            try openNextRecordingLocked(format: format)
            stateLock.unlock()
            call.resolve(result)
        } catch {
            stateLock.unlock()
            call.reject("Unable to save this recording segment.", nil, error)
        }
    }

    @objc func stopRecording(_ call: CAPPluginCall) {
        guard isRecording else {
            call.reject("No recording is active.")
            return
        }
        audioEngine.stop()
        removeAudioTapIfNeeded()
        do {
            stateLock.lock()
            isRecording = false
            let result = try finalizeRecordingLocked(segmentId: call.getString("segmentId"))
            activeAudioFormat = nil
            currentAmplitude = 0
            stateLock.unlock()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            call.resolve(result)
        } catch {
            stateLock.unlock()
            call.reject("Unable to save the final recording segment.", nil, error)
        }
    }

    @objc func cancelRecording(_ call: CAPPluginCall) {
        audioEngine.stop()
        removeAudioTapIfNeeded()
        stateLock.lock()
        isRecording = false
        activeAudioFormat = nil
        currentAmplitude = 0
        discardActiveRecordingLocked()
        stateLock.unlock()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        call.resolve()
    }

    @objc func getCurrentAmplitude(_ call: CAPPluginCall) {
        stateLock.lock()
        let value = isRecording ? currentAmplitude : 0
        stateLock.unlock()
        call.resolve(["value": value])
    }

    deinit {
        audioEngine.stop()
        removeAudioTapIfNeeded()
        stateLock.lock()
        isRecording = false
        discardActiveRecordingLocked()
        speechContext?.task?.cancel()
        speechContext?.request.endAudio()
        speechContext = nil
        speechRecognizer = nil
        stateLock.unlock()
    }

    private func removeAudioTapIfNeeded() {
        guard tapInstalled else { return }
        audioEngine.inputNode.removeTap(onBus: 0)
        tapInstalled = false
    }

    private func startSpeechContextLocked() {
        guard let recognizer = speechRecognizer else {
            speechContext = nil
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        let context = SpeechContext(request: request)
        speechContext = context
        context.task = recognizer.recognitionTask(with: request) { [weak self, weak context] result, error in
            guard let self, let context else { return }
            DispatchQueue.main.async {
                if let result {
                    context.transcript = result.bestTranscription.formattedString
                    if !context.committed {
                        self.notifyListeners("asrEvent", data: [
                            "type": "partial",
                            "text": context.transcript,
                            "stash": "",
                        ])
                    }
                    if result.isFinal {
                        self.completeSpeechContext(context)
                        return
                    }
                }
                if error != nil {
                    if context.committed {
                        self.completeSpeechContext(context)
                    } else if self.speechContext === context {
                        self.notifyListeners("asrEvent", data: [
                            "type": "error",
                            "code": "apple-speech-failed",
                            "message": error?.localizedDescription ?? "Speech recognition failed.",
                        ])
                    }
                }
            }
        }
    }

    private func completeSpeechContext(_ context: SpeechContext) {
        guard context.committed, !context.completed else { return }
        context.completed = true
        notifyListeners("asrEvent", data: [
            "type": "final",
            "requestId": context.requestId ?? "",
            "transcript": context.transcript,
        ])
    }

    private func receiveAudio(_ buffer: AVAudioPCMBuffer) {
        stateLock.lock()
        guard isRecording else {
            stateLock.unlock()
            return
        }
        do {
            try activeAudioFile?.write(from: buffer)
            segmentFrames += AVAudioFramePosition(buffer.frameLength)
        } catch {
            notifyListeners("recordingError", data: ["message": "Unable to write recording evidence."])
        }
        speechContext?.request.append(buffer)
        if speechContext != nil { speechHasAudio = true }
        currentAmplitude = peakAmplitude(buffer)
        stateLock.unlock()
    }

    private func openNextRecordingLocked(format: AVAudioFormat) throws {
        let directory = try recordingsDirectory()
        let url = directory.appendingPathComponent("active-\(UUID().uuidString).wav")
        activeAudioFile = try AVAudioFile(forWriting: url, settings: format.settings)
        activeAudioURL = url
        segmentFrames = 0
    }

    private func finalizeRecordingLocked(segmentId: String?) throws -> [String: Any] {
        guard let source = activeAudioURL, let format = activeAudioFormat else {
            throw NSError(domain: "MyLifeAudio", code: 2, userInfo: [NSLocalizedDescriptionKey: "No active recording file."])
        }
        activeAudioFile = nil
        activeAudioURL = nil
        let safeId = safeIdentifier(segmentId)
        let destination = try recordingsDirectory().appendingPathComponent("\(safeId).wav")
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: source, to: destination)
        let duration = format.sampleRate > 0
            ? Int((Double(segmentFrames) / format.sampleRate) * 1000)
            : 0
        segmentFrames = 0
        return ["uri": destination.absoluteString, "duration": duration]
    }

    private func discardActiveRecordingLocked() {
        activeAudioFile = nil
        if let url = activeAudioURL {
            try? FileManager.default.removeItem(at: url)
        }
        activeAudioURL = nil
        segmentFrames = 0
    }

    private func recordingsDirectory() throws -> URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent("recordings", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func peakAmplitude(_ buffer: AVAudioPCMBuffer) -> Double {
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return 0 }
        var peak: Float = 0
        if let channels = buffer.floatChannelData {
            for channel in 0..<Int(buffer.format.channelCount) {
                for frame in 0..<frames {
                    peak = max(peak, abs(channels[channel][frame]))
                }
            }
        } else if let channels = buffer.int16ChannelData {
            for channel in 0..<Int(buffer.format.channelCount) {
                for frame in 0..<frames {
                    peak = max(peak, Float(abs(Int(channels[channel][frame]))) / Float(Int16.max))
                }
            }
        }
        return min(1, Double(peak))
    }

    private func safeIdentifier(_ value: String?) -> String {
        let fallback = UUID().uuidString
        let raw = (value?.isEmpty == false ? value! : fallback)
        let safe = raw.replacingOccurrences(of: "[^a-zA-Z0-9-]", with: "-", options: .regularExpression)
        return String(safe.prefix(120))
    }

    private func speechLocale(_ language: String) -> Locale {
        if language == "auto" || language.isEmpty {
            return Locale(identifier: Locale.preferredLanguages.first ?? "en-US")
        }
        let identifiers = ["zh-CN": "zh-CN", "zh-TW": "zh-TW", "en": "en-US"]
        return Locale(identifier: identifiers[language] ?? language)
    }

    private func microphonePermissionName() -> String {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        case .undetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }
}

final class MyLifeBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppSettingsPlugin())
        bridge?.registerPluginInstance(RealtimeRecorderPlugin())
    }
}
