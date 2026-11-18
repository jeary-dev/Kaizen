package dev.jeary.kaizen.core.encoding

import java.util.Base64

/**
 * Strict base64url without padding (RFC 4648 §5), as the protocol requires.
 *
 * The JDK's URL decoder accepts padding and non-zero trailing bits, so we check the alphabet and
 * length first and the canonical form afterwards.
 */
object Base64Url {
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    fun encode(bytes: ByteArray): String = encoder.encodeToString(bytes)

    /** Decodes [text], or returns null if it is not strict unpadded base64url. */
    fun decodeOrNull(text: String): ByteArray? {
        if (text.length % 4 == 1) return null
        for (c in text) {
            val ok = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_'
            if (!ok) return null
        }
        val bytes = try {
            decoder.decode(text)
        } catch (_: IllegalArgumentException) {
            return null
        }
        // Reject non-canonical encodings (non-zero trailing bits): one byte string, one text form.
        return bytes.takeIf { encode(it) == text }
    }
}

object Hex {
    private const val DIGITS = "0123456789abcdef"

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            out.append(DIGITS[v ushr 4]).append(DIGITS[v and 0x0f])
        }
        return out.toString()
    }

    fun decode(text: String): ByteArray {
        require(text.length % 2 == 0) { "odd hex length" }
        return ByteArray(text.length / 2) { i ->
            val hi = Character.digit(text[i * 2], 16)
            val lo = Character.digit(text[i * 2 + 1], 16)
            require(hi >= 0 && lo >= 0) { "invalid hex" }
            ((hi shl 4) or lo).toByte()
        }
    }

    private val SHA256_HEX = Regex("^[0-9a-f]{64}$")

    fun isSha256(text: String): Boolean = SHA256_HEX.matches(text)
}
