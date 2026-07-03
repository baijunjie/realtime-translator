//
//  RealtimeTranslate.swift
//  Realtime Translator — iOS on-device translation Capacitor plugin.
//
//  On-device (offline) text translation using Apple's `Translation` framework
//  (iOS 18+). This is the iOS counterpart to the desktop M2M100 local translator:
//  the cloud translator (see apps/ios/src/bridge.ts -> CloudTranslator) stays as an
//  alternative; this plugin powers the non-cloud ("device-local") engine.
//
//  --- Why this is structured the way it is -----------------------------------
//  Apple only exposes `TranslationSession` through SwiftUI's `.translationTask`
//  view modifier — there is NO public initializer. To drive it headlessly from a
//  UIKit/Capacitor plugin we host a tiny, off-screen SwiftUI view inside a
//  `UIHostingController` attached to the app window (0pt frame, hidden). That view
//  has `.translationTask(config)`; the action closure receives the live
//  `TranslationSession`, which we pump with an `AsyncStream` of work items so the
//  SAME session can translate many texts over its lifetime (the closure stays
//  suspended awaiting the stream, keeping the View — and thus the session — alive).
//
//  One session is bound to one source/target language pair. When the requested
//  pair changes we tear down the old host and build a new one. (`Configuration`
//  could be `invalidate()`d to re-run the closure, but our stream-pump keeps one
//  closure running for the lifetime of a pair, which is simpler and avoids races.)
//
//  Language packs: the first translation for a never-used pair may make the system
//  present a download/consent sheet (handled by the framework when the hosting view
//  is on a window). `LanguageAvailability` lets us report installed/supported/
//  unsupported up-front. We call `prepareTranslation()` before the first translate
//  so the download is triggered deterministically.
//
//  IMPORTANT runtime caveat: the Translation framework does NOT work in the iOS
//  Simulator — it requires a real device on iOS 18+. This file compiles against the
//  Simulator SDK (so CI builds stay green); actual translation must be verified on
//  device.
//
//  Contract (must match ../definitions.ts):
//    Methods : translate({text, source, target}) -> { text, unavailable?, reason? }
//              availability({source, target})     -> { status: "installed"|"supported"|"unsupported" }
//
//  Short language codes used across the app: zh / en / ja / ko / yue.
//   - zh maps to Apple language "zh". Traditional Chinese is unified into Simplified
//     upstream (@rt/core), so no Traditional-specific code reaches this plugin.
//   - yue (Cantonese) has no dedicated Apple translation language → best-effort
//     mapped to "zh" (Mandarin written Chinese). Documented; callers may still get
//     "unavailable" if the device lacks the pack.
//

import Foundation
import UIKit
import Capacitor
#if canImport(Translation)
import Translation
#endif
import SwiftUI

@objc(RealtimeTranslatePlugin)
public class RealtimeTranslatePlugin: CAPPlugin, CAPBridgedPlugin {
  // Capacitor 6+ discovers plugins via CAPBridgedPlugin (replaces the old .m / CAP_PLUGIN macro).
  public let identifier = "RealtimeTranslatePlugin"
  public let jsName = "RealtimeTranslate"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
  ]

  /// Lazily-created engine that owns the SwiftUI-hosted TranslationSession(s).
  /// Only instantiated on iOS 18+. The TranslationEngine is `@MainActor`-isolated
  /// (it touches UIKit/SwiftUI), so this box is only ever read/written from the main
  /// actor — see `mainActorEngine()`.
  private var _engine: Any?

  /// Get-or-create the engine on the main actor. Must be awaited from a `@MainActor`
  /// context (Capacitor's TranslationEngine hosts UIKit views).
  @available(iOS 18.0, *)
  @MainActor
  private func mainActorEngine() -> TranslationEngine {
    if let e = _engine as? TranslationEngine { return e }
    let e = TranslationEngine()
    _engine = e
    return e
  }

  // MARK: - Capacitor methods (match ../definitions.ts)

  /// Translate one segment of text from `source` short code to `target` short code.
  /// Resolves { text } on success, or { text: "", unavailable: true, reason } when
  /// translation can't be performed (iOS < 18, unsupported pair, missing pack, etc.)
  /// so the JS bridge can fall back / message the user instead of seeing a reject.
  @objc func translate(_ call: CAPPluginCall) {
    let text = call.getString("text") ?? ""
    let source = call.getString("source") ?? ""
    let target = call.getString("target") ?? ""

    if text.isEmpty {
      call.resolve(["text": ""])
      return
    }

    guard #available(iOS 18.0, *) else {
      call.resolve(unavailable("on-device translation requires iOS 18 or later"))
      return
    }

    guard let srcLang = Self.appleLanguage(for: source) else {
      call.resolve(unavailable("unsupported source language: \(source)"))
      return
    }
    guard let dstLang = Self.appleLanguage(for: target) else {
      call.resolve(unavailable("unsupported target language: \(target)"))
      return
    }

    Task { @MainActor in
      let engine = self.mainActorEngine()
      let result = await engine.translate(text: text, source: srcLang, target: dstLang)
      switch result {
      case .success(let translated):
        call.resolve(["text": translated])
      case .unavailable(let reason):
        call.resolve(self.unavailable(reason))
      }
    }
  }

  /// Report whether a language pair is installed / supported (downloadable) / unsupported.
  @objc func availability(_ call: CAPPluginCall) {
    let source = call.getString("source") ?? ""
    let target = call.getString("target") ?? ""

    guard #available(iOS 18.0, *) else {
      call.resolve(["status": "unsupported"])
      return
    }
    guard let srcLang = Self.appleLanguage(for: source),
          let dstLang = Self.appleLanguage(for: target) else {
      call.resolve(["status": "unsupported"])
      return
    }

    Task { @MainActor in
      let status = await TranslationEngine.availability(source: srcLang, target: dstLang)
      call.resolve(["status": status])
    }
  }

  // MARK: - Helpers

  private func unavailable(_ reason: String) -> [String: Any] {
    return ["text": "", "unavailable": true, "reason": reason]
  }

  /// Map our short ASR/app language codes to an Apple `Locale.Language`.
  /// Returns nil for codes Apple's Translation framework cannot represent.
  ///   zh          -> "zh"   (Traditional is unified into Simplified upstream)
  ///   yue         -> "zh"   (best-effort; no dedicated Cantonese translation language)
  ///   en/ja/ko    -> as-is
  @available(iOS 18.0, *)
  static func appleLanguage(for shortCode: String) -> Locale.Language? {
    switch shortCode {
    case "zh", "yue":
      return Locale.Language(identifier: "zh")
    case "en":
      return Locale.Language(identifier: "en")
    case "ja":
      return Locale.Language(identifier: "ja")
    case "ko":
      return Locale.Language(identifier: "ko")
    default:
      // Unknown code: let Apple try to parse it; if it's a real BCP-47 tag this works,
      // otherwise availability/translate will surface "unavailable".
      let lang = Locale.Language(identifier: shortCode)
      return lang.languageCode == nil ? nil : lang
    }
  }
}

// MARK: - TranslationEngine (iOS 18+): owns SwiftUI-hosted TranslationSession(s)

#if canImport(Translation)

@available(iOS 18.0, *)
enum TranslateOutcome {
  case success(String)
  case unavailable(String)
}

/// One unit of work pushed into a session's request stream.
@available(iOS 18.0, *)
private struct TranslateWork {
  let text: String
  let completion: (TranslateOutcome) -> Void
}

/// Resumes a CheckedContinuation at most once, from whichever caller (session completion or
/// timeout) fires first. Lock-guarded and @unchecked Sendable so it can be shared with the
/// timeout Task without tripping Sendable checks. Owns that timeout Task so a completed
/// translate cancels the pending sleep instead of letting it idle out the full window.
@available(iOS 18.0, *)
private final class ResumeOnceBox: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<TranslateOutcome, Never>?
  private var timeoutTask: Task<Void, Never>?

  init(_ continuation: CheckedContinuation<TranslateOutcome, Never>) {
    self.continuation = continuation
  }

  /// Register the timeout task; cancelled immediately when the continuation already resumed.
  func setTimeoutTask(_ task: Task<Void, Never>) {
    lock.lock()
    let alreadyResumed = continuation == nil
    if !alreadyResumed { timeoutTask = task }
    lock.unlock()
    if alreadyResumed { task.cancel() }
  }

  func resume(_ outcome: TranslateOutcome) {
    lock.lock()
    let cont = continuation
    continuation = nil
    let task = timeoutTask
    timeoutTask = nil
    lock.unlock()
    cont?.resume(returning: outcome)
    task?.cancel()
  }
}

/// Drives Apple's `TranslationSession` headlessly by hosting an off-screen SwiftUI
/// view. One `SessionHost` is bound to a single source/target pair; the hosted
/// view's `.translationTask` closure stays alive consuming an AsyncStream of work,
/// so the same session translates many texts over time.
@available(iOS 18.0, *)
@MainActor
final class TranslationEngine {

  /// Active host keyed by "source->target"; recreated when the pair changes.
  private var hosts: [String: SessionHost] = [:]

  static func availability(source: Locale.Language, target: Locale.Language) async -> String {
    let status = await LanguageAvailability().status(from: source, to: target)
    switch status {
    case .installed: return "installed"
    case .supported: return "supported"
    case .unsupported: return "unsupported"
    @unknown default: return "unsupported"
    }
  }

  func translate(text: String, source: Locale.Language, target: Locale.Language) async -> TranslateOutcome {
    // Fast pre-check so a clearly unsupported pair never spins up a host.
    let avail = await LanguageAvailability().status(from: source, to: target)
    if avail == .unsupported {
      return .unavailable("language pair not supported on this device")
    }

    let key = Self.key(source, target)
    let host: SessionHost
    if let existing = hosts[key] {
      host = existing
    } else {
      host = SessionHost(source: source, target: target)
      hosts[key] = host
    }

    return await host.translate(text)
  }

  private static func key(_ s: Locale.Language, _ t: Locale.Language) -> String {
    return "\(s.minimalIdentifier)->\(t.minimalIdentifier)"
  }
}

/// Hosts a hidden SwiftUI view whose `.translationTask` supplies a live session.
/// Work items are delivered via an AsyncStream; results returned via per-item
/// completion handlers. The hosting controller is retained for the host's lifetime.
@available(iOS 18.0, *)
@MainActor
private final class SessionHost {
  private let source: Locale.Language
  private let target: Locale.Language

  private var hostingController: UIHostingController<TranslationDriverView>?
  private var continuation: AsyncStream<TranslateWork>.Continuation?

  /// Upper bound for a single translate; matches @rt/core's cloud REQUEST_TIMEOUT_MS so a stuck
  /// session (missing/large pack, unpresented consent sheet, framework hang) can't wedge a line.
  private let requestTimeoutSeconds: Double = 30

  init(source: Locale.Language, target: Locale.Language) {
    self.source = source
    self.target = target
  }

  func translate(_ text: String) async -> TranslateOutcome {
    ensureHostAttached()
    guard let continuation = continuation else {
      return .unavailable("could not start translation session")
    }
    let timeout = requestTimeoutSeconds
    return await withCheckedContinuation { (cont: CheckedContinuation<TranslateOutcome, Never>) in
      // Resume-once guard: whichever of {session completion, timeout} fires first resumes; the
      // other becomes a no-op, so a late-completing translate can never double-resume.
      let box = ResumeOnceBox(cont)
      let work = TranslateWork(text: text) { outcome in box.resume(outcome) }
      continuation.yield(work)
      box.setTimeoutTask(Task {
        try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
        box.resume(.unavailable("translation timed out"))
      })
    }
  }

  /// Ensure the hidden hosting controller exists AND is attached to a live window (off-screen),
  /// so the SwiftUI view lifecycle — and the Translation framework's ability to present any
  /// system download/consent sheet — is active. The controller is built once, but attachment is
  /// retried on every call: if no window was available yet (or the view got detached) we leave it
  /// unattached and re-add it next time, rather than caching a permanently-dead host.
  private func ensureHostAttached() {
    if hostingController == nil {
      var cont: AsyncStream<TranslateWork>.Continuation?
      let stream = AsyncStream<TranslateWork> { c in cont = c }
      self.continuation = cont

      let config = TranslationSession.Configuration(source: source, target: target)
      let view = TranslationDriverView(configuration: config, work: stream)
      let controller = UIHostingController(rootView: view)
      controller.view.frame = .zero
      controller.view.isUserInteractionEnabled = false
      controller.view.isHidden = true
      controller.view.alpha = 0
      self.hostingController = controller
    }

    // Attach only when not already in a window hierarchy; skip silently if no window exists yet
    // (work items buffer in the AsyncStream and drain once the view finally appears).
    if let controller = hostingController, controller.view.window == nil,
       let window = Self.activeWindow() {
      window.addSubview(controller.view)
    }
  }

  private static func activeWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    for scene in scenes {
      if let key = scene.windows.first(where: { $0.isKeyWindow }) { return key }
    }
    return scenes.first?.windows.first
  }

  deinit {
    continuation?.finish()
    // UIHostingController teardown must hop to the main actor.
    let controller = hostingController
    Task { @MainActor in controller?.view.removeFromSuperview() }
  }
}

/// The tiny off-screen SwiftUI view that exposes a live `TranslationSession`.
/// It drains a stream of work items, translating each through the one session.
@available(iOS 18.0, *)
private struct TranslationDriverView: View {
  let configuration: TranslationSession.Configuration
  let work: AsyncStream<TranslateWork>

  @State private var config: TranslationSession.Configuration?

  var body: some View {
    Color.clear
      .frame(width: 0, height: 0)
      .translationTask(config) { session in
        // Prepare the language pack up-front so the first translate is deterministic
        // (this is also where the system may present a download/consent sheet).
        do {
          try await session.prepareTranslation()
        } catch {
          // Non-fatal: translate() below will still surface a per-item error.
        }
        // Consume work for the lifetime of this view; one session, many texts.
        for await item in work {
          do {
            let response = try await session.translate(item.text)
            item.completion(.success(response.targetText))
          } catch {
            item.completion(.unavailable("translation failed: \(error.localizedDescription)"))
          }
        }
      }
      .onAppear {
        // Setting the config (non-nil) is what kicks off the translationTask closure.
        if config == nil { config = configuration }
      }
  }
}

#endif
