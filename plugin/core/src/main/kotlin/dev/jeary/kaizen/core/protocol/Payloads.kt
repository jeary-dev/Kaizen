package dev.jeary.kaizen.core.protocol

import dev.jeary.kaizen.core.encoding.Hex
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.time.format.DateTimeParseException

@Serializable
enum class Lang {
    @SerialName("yaml") YAML,
    @SerialName("json") JSON,
    @SerialName("properties") PROPERTIES,
    @SerialName("toml") TOML,
    @SerialName("conf") CONF,
    @SerialName("text") TEXT,
    ;

    companion object {
        fun forPath(path: String): Lang = when (ProtocolPaths.extensionOf(path)) {
            "yml", "yaml" -> YAML
            "json" -> JSON
            "properties" -> PROPERTIES
            "toml" -> TOML
            "conf" -> CONF
            else -> TEXT
        }
    }
}

@Serializable
data class ServerInfo(val software: String, val kaizen: String)

@Serializable
data class SecretRef(val id: String, val key: String, val line: Int)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class UploadFile(
    val path: String,
    @EncodeDefault val plugin: String? = null,
    val lang: Lang,
    val sha256: String,
    val content: String,
    @EncodeDefault val secrets: List<SecretRef> = emptyList(),
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class UploadPayload(
    @EncodeDefault val format: String = FORMAT,
    @EncodeDefault val v: Int = 1,
    val sid: String,
    val createdAt: String,
    val expiresAt: String,
    val server: ServerInfo,
    val scope: String,
    val files: List<UploadFile>,
    @EncodeDefault val reloadHints: Map<String, String> = emptyMap(),
) {
    companion object {
        const val FORMAT = "kaizen.upload"
    }
}

@Serializable
data class ChangedFile(val path: String, val baseSha256: String, val content: String)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class ChangesPayload(
    @EncodeDefault val format: String = FORMAT,
    @EncodeDefault val v: Int = 1,
    val sid: String,
    val uploadSha256: String,
    val createdAt: String,
    val files: List<ChangedFile>,
) {
    companion object {
        const val FORMAT = "kaizen.changes"
    }
}

/**
 * JSON encoding and structural validation for the decrypted payloads (protocol §5 and §6).
 *
 * The checks here hold for any receiver. Checks that need session state, such as "this path was in
 * my upload" or "the file on disk still matches", belong to the apply layer.
 */
object PayloadCodec {
    val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = false
        coerceInputValues = false
        explicitNulls = true
    }

    fun encodeUpload(payload: UploadPayload): ByteArray =
        json.encodeToString(UploadPayload.serializer(), payload).toByteArray(Charsets.UTF_8)

    fun encodeChanges(payload: ChangesPayload): ByteArray =
        json.encodeToString(ChangesPayload.serializer(), payload).toByteArray(Charsets.UTF_8)

    fun decodeUpload(bytes: ByteArray, expectedSid: String): UploadPayload {
        val obj = header(bytes, UploadPayload.FORMAT)
        val payload = decode(obj) { json.decodeFromJsonElement(UploadPayload.serializer(), it) }
        if (payload.sid != expectedSid) fail(Reason.MISMATCH, "upload belongs to a different session")
        timestamp(payload.createdAt, "createdAt")
        timestamp(payload.expiresAt, "expiresAt")
        uniquePaths(payload.files.map { it.path })
        for (file in payload.files) {
            sha(file.sha256, "files[].sha256")
            for (secret in file.secrets) {
                if (!Placeholders.ID_PATTERN.matches(secret.id)) fail(Reason.MALFORMED, "invalid placeholder id")
            }
        }
        return payload
    }

    fun decodeChanges(bytes: ByteArray, expectedSid: String): ChangesPayload {
        val obj = header(bytes, ChangesPayload.FORMAT)
        val payload = decode(obj) { json.decodeFromJsonElement(ChangesPayload.serializer(), it) }
        if (payload.sid != expectedSid) fail(Reason.MISMATCH, "changes belong to a different session")
        sha(payload.uploadSha256, "uploadSha256")
        timestamp(payload.createdAt, "createdAt")
        if (payload.files.isEmpty()) fail(Reason.MALFORMED, "the change set is empty")
        uniquePaths(payload.files.map { it.path })
        for (file in payload.files) sha(file.baseSha256, "files[].baseSha256")
        return payload
    }

    /** Checks `format` and `v` before the full decode: a v2 payload might be shaped differently. */
    private fun header(bytes: ByteArray, format: String): JsonObject {
        val text = EnvelopeCodec.utf8(bytes)
        val element = try {
            json.parseToJsonElement(text)
        } catch (e: SerializationException) {
            fail(Reason.MALFORMED, "payload is not valid JSON", e)
        }
        val obj = element as? JsonObject ?: fail(Reason.MALFORMED, "payload must be a JSON object")
        val actualFormat = (obj["format"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (actualFormat != format) fail(Reason.UNSUPPORTED, "expected a $format payload")
        val v = (obj["v"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
        if (v != 1L) fail(Reason.UNSUPPORTED, "payload version $v is not supported")
        return obj
    }

    private inline fun <T> decode(obj: JsonObject, block: (JsonObject) -> T): T = try {
        block(obj)
    } catch (e: SerializationException) {
        fail(Reason.MALFORMED, "payload has missing or mistyped fields", e)
    } catch (e: IllegalArgumentException) {
        fail(Reason.MALFORMED, "payload has missing or mistyped fields", e)
    }

    private fun uniquePaths(paths: List<String>) {
        paths.forEach(ProtocolPaths::require)
        if (paths.toSet().size != paths.size) fail(Reason.PATH, "a path appears more than once")
    }

    private fun sha(value: String, field: String) {
        if (!Hex.isSha256(value)) fail(Reason.MALFORMED, "$field is not a lowercase SHA-256 hex digest")
    }

    private fun timestamp(value: String, field: String) {
        try {
            Instant.parse(value)
        } catch (e: DateTimeParseException) {
            fail(Reason.MALFORMED, "$field is not an ISO-8601 instant", e)
        }
    }
}
