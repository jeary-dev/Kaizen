package dev.jeary.kaizen.core.crypto

import dev.jeary.kaizen.core.encoding.Base64Url
import dev.jeary.kaizen.core.encoding.Hex
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** SHA-256, HMAC and HKDF helpers. All of them are JDK-only. */
object Digests {
    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun sha256Hex(bytes: ByteArray): String = Hex.encode(sha256(bytes))

    fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }

    /** Constant-time equality, so comparisons don't leak how many leading bytes matched. */
    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    /** HKDF-SHA256 (RFC 5869). The JDK 21 API has no HKDF, so we build it from HMAC. */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..255 * 32) { "invalid HKDF output length $length" }
        val prk = hmacSha256(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val n = minOf(previous.size, length - offset)
            System.arraycopy(previous, 0, out, offset, n)
            offset += n
            counter++
        }
        return out
    }
}

/** The single source of randomness for keys, ids, IVs and tags. */
object Randomness {
    private val secure = SecureRandom()

    fun bytes(count: Int): ByteArray = ByteArray(count).also(secure::nextBytes)

    /** Picks [count] characters from [alphabet] without modulo bias. */
    fun chars(alphabet: String, count: Int): String = buildString(count) {
        repeat(count) { append(alphabet[secure.nextInt(alphabet.length)]) }
    }
}

/**
 * Per-session key material derived from the session key `K` (protocol §3).
 *
 * [key] is what goes into the link fragment. Nothing derived from it is ever sent anywhere except
 * the edit token, and the web server only ever stores a hash of that.
 */
class SessionKeys(val key: ByteArray, val sid: String) {
    init {
        require(key.size == KEY_BYTES) { "session key must be $KEY_BYTES bytes" }
    }

    private val salt = sid.toByteArray(Charsets.UTF_8)

    val up: ByteArray = derive("kaizen/v1/up")
    val down: ByteArray = derive("kaizen/v1/down")
    val editToken: ByteArray = derive("kaizen/v1/edit-auth")

    /** `hex(SHA-256(editToken))`, the only form of the edit token the web server keeps. */
    val editHash: String get() = Digests.sha256Hex(editToken)

    /** The URL fragment value, without `#k=`. */
    val fragmentKey: String get() = Base64Url.encode(key)

    private fun derive(label: String) =
        Digests.hkdfSha256(key, salt, label.toByteArray(Charsets.UTF_8), KEY_BYTES)

    companion object {
        const val KEY_BYTES = 32

        /** A fresh session: random key and random 128-bit id. */
        fun generate(): SessionKeys = SessionKeys(Randomness.bytes(KEY_BYTES), SessionId.generate())
    }
}

object SessionId {
    private val PATTERN = Regex("^[A-Za-z0-9_-]{22}$")

    fun generate(): String = Base64Url.encode(Randomness.bytes(16))

    fun isValid(sid: String): Boolean = PATTERN.matches(sid)
}

/**
 * The per-install owner secret `T` (protocol §2). It proves to the web API that this server created
 * a session, so only this server can claim the session's changes.
 */
class OwnerSecret(private val secret: ByteArray) {
    init {
        require(secret.size == BYTES) { "owner secret must be $BYTES bytes" }
    }

    /** Sent as `Authorization: Bearer <this>` when claiming or closing a session. */
    val bearer: String get() = Base64Url.encode(secret)

    /** `hex(SHA-256(HMAC-SHA256(T, sid)))`. Hashes from different sessions can't be linked. */
    fun hashFor(sid: String): String =
        Digests.sha256Hex(Digests.hmacSha256(secret, sid.toByteArray(Charsets.UTF_8)))

    companion object {
        const val BYTES = 32

        fun generate(): OwnerSecret = OwnerSecret(Randomness.bytes(BYTES))

        fun parse(text: String): OwnerSecret? =
            Base64Url.decodeOrNull(text.trim())?.takeIf { it.size == BYTES }?.let(::OwnerSecret)
    }
}
