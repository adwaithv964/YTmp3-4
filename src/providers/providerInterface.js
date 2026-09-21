/**
 * Provider interface (JSDoc contract).
 *
 * All provider implementations must implement the functions described here.
 * This file is documentation only — there is no runtime enforcement.
 *
 * @typedef {Object} MediaFormat
 * @property {string} label         - Human-readable label e.g. "720p HD"
 * @property {string} value         - Machine value e.g. "720"
 *
 * @typedef {Object} MediaMetadata
 * @property {string}   title
 * @property {string}   thumbnail              - HTTPS URL of best thumbnail
 * @property {number}   duration               - Duration in seconds
 * @property {string}   durationString         - Formatted e.g. "3:45"
 * @property {string}   uploader
 * @property {string}   videoId
 * @property {boolean}  isLive
 * @property {MediaFormat[]} availableVideoQualities
 * @property {string[]} availableAudioBitrates - e.g. ["128","192","256","320"]
 *
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} supportsVideo
 * @property {boolean} supportsAudio
 * @property {string[]} supportedFormats
 *
 * Provider interface:
 *
 * validateSource(urlString: string): Promise<void>
 *   Quickly checks if the URL is reachable and is a supported media source.
 *   Throws ProviderError or UnsupportedSourceError on failure.
 *
 * getMetadata(urlString: string): Promise<MediaMetadata>
 *   Fetches full metadata including available quality options.
 *   Throws ProviderError if metadata cannot be retrieved.
 *
 * getCapabilities(): ProviderCapabilities
 *   Returns static capability info for this provider.
 */

export const PROVIDER_INTERFACE_VERSION = '1.0.0';
