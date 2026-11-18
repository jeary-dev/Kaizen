package dev.jeary.kaizen.core.protocol

import dev.jeary.kaizen.core.crypto.Randomness
import dev.jeary.kaizen.core.crypto.SessionKeys
import dev.jeary.kaizen.core.encoding.Base64Url
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

enum class Kind(val wire: String) {
    UPLOAD("upload"),
    CHANGES("changes"),
    ;

    companion object {
        fun fromWire(value: String): Kind? = entries.firstOrNull { it.wire == value }
    }
}

/** The outer, server-visible message (protocol §4). Everything but the routing fields is ciphertext. */
data class Envelope(
    val kind: Kind,
    val sid: String,
    val rev: Long,
    val iv: ByteArray,
    val ct: ByteArray,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("v", VERSION)
        put("alg", ALG)
        put("kind", kind.wire)
        put("sid", sid)
        put("rev", rev)
        put("iv", Base64Url.encode(iv))
        put("ct", Base64Url.encode(ct))
    }

    fun encode(): String = toJson().toString()

    override fun equals(other: Any?): Boolean =
        other is Envelope && kind == other.kind && sid == other.sid && rev == other.rev &&
            iv.contentEquals(other.iv) && ct.contentEquals(other.ct)

    override fun hashCode(): Int {
        var result = kind.hashCode()
        result = 31 * result + sid.hashCode()
        result = 31 * result + rev.hashCode()
        result = 31 * result + iv.contentHashCode()
        return 31 * result + ct.contentHashCode()
    }

    companion object {
        const val VERSION = 1
        const val ALG = "A256GCM"
        const val IV_BYTES = 12
        const val TAG_BYTES = 16

        fun parse(text: String): Envelope {
            val element = try {
                Json.parseToJsonElement(text)
            } catch (e: IllegalArgumentException) {
                fail(Reason.MALFORMED, "envelope is not valid JSON", e)
            }
            return fromJson(element)
        }

        /** Strict structural validation. Types are checked exactly, so `"0"` is not a number. */
        fun fromJson(element: JsonElement): Envelope {
            val obj = element as? JsonObject ?: fail(Reason.MALFORMED, "envelope must be a JSON object")

            fun str(name: String): String {
                val p = obj[name] as? JsonPrimitive
                if (p == null || !p.isString) fail(Reason.MALFORMED, "envelope.$name must be a string")
                return p.content
            }

            fun int(name: String): Long {
                val p = obj[name] as? JsonPrimitive
                val value = if (p == null || p.isString) null else p.longOrNull
                return value ?: fail(Reason.MALFORMED, "envelope.$name must be an integer")
            }

            val v = int("v")
            if (v != VERSION.toLong()) fail(Reason.UNSUPPORTED, "envelope version $v is not supported (expected $VERSION)")
            val alg = str("alg")
            if (alg != ALG) fail(Reason.UNSUPPORTED, "algorithm $alg is not supported")

            val kind = Kind.fromWire(str("kind")) ?: fail(Reason.MALFORMED, "envelope.kind is unknown")
            val sid = str("sid")
            val rev = int("rev")
            when (kind) {
                Kind.UPLOAD -> if (rev != 0L) fail(Reason.MALFORMED, "an upload must have rev 0")
                Kind.CHANGES -> if (rev < 1L) fail(Reason.MALFORMED, "changes must have rev >= 1")
            }
            val iv = Base64Url.decodeOrNull(str("iv")) ?: fail(Reason.MALFORMED, "envelope.iv is not base64url")
            if (iv.size != IV_BYTES) fail(Reason.MALFORMED, "envelope.iv must be $IV_BYTES bytes")
            val ct = Base64Url.decodeOrNull(str("ct")) ?: fail(Reason.MALFORMED, "envelope.ct is not base64url")
            if (ct.size < TAG_BYTES) fail(Reason.MALFORMED, "envelope.ct is shorter than the GCM tag")
            return Envelope(kind, sid, rev, iv, ct)
        }
    }
}

/**
 * Seals and opens envelopes (protocol §4): gzip, then AES-256-GCM with the session/kind/rev bound in
 * as associated data.
 */
object EnvelopeCodec {
    const val DEFAULT_MAX_PLAINTEXT_BYTES: Int = 32 * 1024 * 1024

    fun aad(kind: Kind, sid: String, rev: Long): ByteArray =
        "kaizen/v1|${kind.wire}|$sid|$rev".toByteArray(Charsets.UTF_8)

    /** Seals [plaintext]. [iv] and [precompressed] exist only so tests can reproduce the vectors. */
    fun seal(
        keys: SessionKeys,
        kind: Kind,
        rev: Long,
        plaintext: ByteArray,
        iv: ByteArray = Randomness.bytes(Envelope.IV_BYTES),
        precompressed: ByteArray? = null,
    ): Envelope {
        require(iv.size == Envelope.IV_BYTES) { "IV must be ${Envelope.IV_BYTES} bytes" }
        val compressed = precompressed ?: gzip(plaintext)
        val cipher = cipher(Cipher.ENCRYPT_MODE, keyFor(keys, kind), iv)
        cipher.updateAAD(aad(kind, keys.sid, rev))
        return Envelope(kind, keys.sid, rev, iv, cipher.doFinal(compressed))
    }

    /**
     * Opens [envelope]. [keys] carries the session id we **expect**, and the AAD is built from it
     * and [expectedKind], never from the envelope's own labels.
     *
     * Order matters: nothing is decompressed or parsed until the tag has verified.
     */
    fun open(
        keys: SessionKeys,
        expectedKind: Kind,
        envelope: Envelope,
        maxPlaintextBytes: Int = DEFAULT_MAX_PLAINTEXT_BYTES,
    ): ByteArray {
        if (envelope.sid != keys.sid) fail(Reason.MISMATCH, "envelope belongs to a different session")
        if (envelope.kind != expectedKind) {
            fail(Reason.MISMATCH, "expected ${expectedKind.wire} but received ${envelope.kind.wire}")
        }
        val cipher = cipher(Cipher.DECRYPT_MODE, keyFor(keys, expectedKind), envelope.iv)
        cipher.updateAAD(aad(expectedKind, keys.sid, envelope.rev))
        val compressed = try {
            cipher.doFinal(envelope.ct)
        } catch (e: AEADBadTagException) {
            fail(Reason.AUTH, "authentication failed: the data was altered or the key is wrong", e)
        }
        return gunzip(compressed, maxPlaintextBytes)
    }

    /** Strict UTF-8 decoding: malformed sequences are an error, never replaced. */
    fun utf8(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (e: CharacterCodingException) {
        fail(Reason.MALFORMED, "payload is not valid UTF-8", e)
    }

    fun gzip(bytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(bytes.size / 3 + 64)
        GZIPOutputStream(out).use { it.write(bytes) }
        return out.toByteArray()
    }

    /** Gunzips, stopping as soon as the output passes [limit] so a small bomb can't exhaust memory. */
    fun gunzip(bytes: ByteArray, limit: Int): ByteArray {
        val out = ByteArrayOutputStream()
        try {
            GZIPInputStream(ByteArrayInputStream(bytes)).use { input ->
                val buffer = ByteArray(16 * 1024)
                var total = 0L
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    total += n
                    if (total > limit) fail(Reason.OVERSIZE, "decompressed payload is larger than $limit bytes")
                    out.write(buffer, 0, n)
                }
            }
        } catch (e: IOException) {
            fail(Reason.MALFORMED, "payload is not valid gzip", e)
        }
        val result = out.toByteArray()
        // Validate UTF-8 here so callers always receive well-formed text bytes.
        utf8(result)
        return result
    }

    private fun keyFor(keys: SessionKeys, kind: Kind) = when (kind) {
        Kind.UPLOAD -> keys.up
        Kind.CHANGES -> keys.down
    }

    private fun cipher(mode: Int, key: ByteArray, iv: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(Envelope.TAG_BYTES * 8, iv))
        }
}
