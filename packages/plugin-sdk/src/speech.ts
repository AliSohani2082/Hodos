/**
 * Speech contracts — EXPERIMENTAL. Hodos ships no speech implementation, and
 * no host in this repository registers these providers yet.
 *
 * Text-to-speech, speech recognition, pronunciation assessment and spoken
 * conversation each need a provider the host has decided to trust: an engine
 * on the learner's device, or a service the learner chose. Every
 * implementation must keep two rules:
 *
 * - Pronunciation is assessed from the audio by an acoustic model. A text
 *   model reading a transcript cannot assess pronunciation, so a
 *   {@link PronunciationAssessment} always says `method: 'acoustic'`.
 * - Audio leaves the device only with the learner's explicit consent; a
 *   provider declares where it runs in `locality`.
 * @module @hodos/plugin-sdk/speech
 */

/** A piece of audio. */
export interface AudioClip {
  /** For example `audio/wav` or `audio/webm`. */
  readonly mimeType: string
  readonly data: Uint8Array
}

/** Where a provider processes audio or text. */
export type ProviderLocality = 'device' | 'remote'

/** Text-to-speech. */
export interface SpeechSynthesisProvider {
  readonly id: string
  /** BCP 47 tags the provider speaks, e.g. `es-ES`. */
  readonly languages: readonly string[]
  readonly locality: ProviderLocality
  synthesize(request: { readonly text: string; readonly language: string; readonly rate?: number }): Promise<AudioClip>
}

/** Speech-to-text. */
export interface SpeechRecognitionProvider {
  readonly id: string
  readonly languages: readonly string[]
  readonly locality: ProviderLocality
  transcribe(request: { readonly audio: AudioClip; readonly language: string }): Promise<{ readonly text: string; readonly confidence: number | null }>
}

/** Result of assessing a spoken attempt against a reference text. */
export interface PronunciationAssessment {
  /** Scores come from the audio signal, never from a transcript alone. */
  readonly method: 'acoustic'
  /** Overall score in [0, 1]. */
  readonly overall: number
  readonly words: ReadonlyArray<{ readonly word: string; readonly score: number }>
}

/** Pronunciation assessment. */
export interface PronunciationAssessor {
  readonly id: string
  readonly languages: readonly string[]
  readonly locality: ProviderLocality
  assess(request: { readonly audio: AudioClip; readonly language: string; readonly referenceText: string }): Promise<PronunciationAssessment>
}

/**
 * A conversation partner for free practice. Its turns are practice only:
 * the platform never records them as mastery evidence.
 */
export interface ConversationPartner {
  readonly id: string
  readonly language: string
  readonly locality: ProviderLocality
  reply(request: {
    readonly history: ReadonlyArray<{ readonly role: 'learner' | 'partner'; readonly text: string }>
    readonly level?: string
  }): Promise<{ readonly text: string }>
}
