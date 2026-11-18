package dev.jeary.kaizen.core.http

import dev.jeary.kaizen.core.protocol.Envelope
import kotlinx.coroutines.future.await
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.ConnectException
import java.net.URI
import java.net.UnknownHostException
import java.net.http.HttpClient
import java.net.http.HttpConnectTimeoutException
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.nio.channels.UnresolvedAddressException
import java.time.Duration
import java.util.concurrent.CompletionException
import javax.net.ssl.SSLException

/** Why a web API call failed, in terms an admin can act on. */
enum class ApiFailure {
    /** DNS failed, the connection was refused, or it timed out. Often the host blocks outbound traffic. */
    UNREACHABLE,
    TLS,
    TIMEOUT,
    /** The server answered with an error (see [ApiException.status] and [ApiException.code]). */
    HTTP,
    /** The server answered with something we don't understand. Usually the wrong web URL. */
    PROTOCOL,
}

class ApiException(
    val failure: ApiFailure,
    message: String,
    val status: Int = 0,
    val code: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

@Serializable
data class EditorServerInfo(
    val name: String,
    val protocols: List<Int>,
    val ttl: Ttl,
    val limits: Limits,
) {
    @Serializable
    data class Ttl(val min: Int, val default: Int, val max: Int)

    @Serializable
    data class Limits(val uploadBytes: Long, val changesBytes: Long)
}

@Serializable
data class CreatedSession(val sid: String, val expiresAt: String, val ttlSeconds: Int)

class ClaimedChanges(val sid: String, val envelope: Envelope)

/**
 * The plugin side of the web API. Every call is outbound HTTPS, made off the main thread through
 * the JDK client, so it needs no extra libraries. Owner tokens travel only in `Authorization`.
 */
class KaizenApi(
    baseUrl: String,
    private val userAgent: String,
    private val timeout: Duration = Duration.ofSeconds(15),
    // HTTP/1.1 on purpose: over plain http:// (localhost, self-hosted behind a proxy) the JDK's
    // default HTTP/2 sends an `Upgrade: h2c` request, which Node servers answer by closing the
    // connection. A handful of small requests gains nothing from HTTP/2 anyway.
    private val client: HttpClient = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build(),
) {
    private val base = baseUrl.trimEnd('/')
    private val host = runCatching { URI.create(base).host }.getOrNull() ?: base
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun info(): EditorServerInfo = decode(EditorServerInfo.serializer(), send(get("/api/v1/info"), expect = 200))

    suspend fun createSession(envelope: Envelope, ownerHash: String, editHash: String, ttlSeconds: Int): CreatedSession {
        val body = buildJsonObject {
            put("envelope", envelope.toJson())
            put("ownerHash", ownerHash)
            put("editHash", editHash)
            put("ttlSeconds", ttlSeconds)
        }
        return decode(CreatedSession.serializer(), send(post("/api/v1/sessions", body), expect = 201))
    }

    suspend fun claim(code: String, ownerBearer: String): ClaimedChanges {
        val text = send(post("/api/v1/claim", buildJsonObject { put("code", code) }, ownerBearer), expect = 200)
        val obj = parse(text) as? JsonObject ?: throw protocolError("claim response is not an object")
        val sid = (obj["sid"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: throw protocolError("claim response has no sid")
        val envelope = obj["envelope"] ?: throw protocolError("claim response has no envelope")
        return ClaimedChanges(sid, Envelope.fromJson(envelope))
    }

    suspend fun markApplied(sid: String, ownerBearer: String) {
        send(post("/api/v1/sessions/$sid/applied", JsonObject(emptyMap()), ownerBearer), expect = 204)
    }

    suspend fun discard(sid: String, ownerBearer: String) {
        send(
            request("/api/v1/sessions/$sid").DELETE().header("Authorization", "Bearer $ownerBearer").build(),
            expect = 204,
        )
    }

    // ---------------------------------------------------------------------------------------------

    private fun request(path: String): HttpRequest.Builder =
        HttpRequest.newBuilder(URI.create(base + path))
            .timeout(timeout)
            .header("User-Agent", userAgent)
            .header("Accept", "application/json")

    private fun get(path: String) = request(path).GET().build()

    private fun post(path: String, body: JsonElement, bearer: String? = null): HttpRequest =
        request(path)
            .header("Content-Type", "application/json")
            .apply { if (bearer != null) header("Authorization", "Bearer $bearer") }
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
            .build()

    private suspend fun send(request: HttpRequest, expect: Int): String {
        val response = try {
            client.sendAsync(request, HttpResponse.BodyHandlers.ofString()).await()
        } catch (e: CompletionException) {
            throw translate(e.cause ?: e)
        } catch (e: IOException) {
            throw translate(e)
        }
        val status = response.statusCode()
        if (status == expect) return response.body()
        val (code, message) = errorBody(response.body())
        throw when (status) {
            429 -> ApiException(ApiFailure.HTTP, "the editor server is rate limiting this server; wait a minute and try again", status, code)
            in 300..399 -> ApiException(ApiFailure.PROTOCOL, "$host redirected the request; check web-url in config.yml (it must be the exact https:// address)", status)
            else -> ApiException(
                if (code != null) ApiFailure.HTTP else ApiFailure.PROTOCOL,
                message ?: "unexpected HTTP $status from $host; is web-url in config.yml correct?",
                status,
                code,
            )
        }
    }

    private fun translate(error: Throwable): ApiException = when (error) {
        is HttpConnectTimeoutException, is ConnectException, is UnknownHostException, is UnresolvedAddressException ->
            ApiException(
                ApiFailure.UNREACHABLE,
                "could not connect to $host. Your host may block outbound connections (common on shared hosting); " +
                    "ask them to allow HTTPS to $host, or check web-url in config.yml",
                cause = error,
            )
        is HttpTimeoutException -> ApiException(ApiFailure.TIMEOUT, "$host did not answer in time; try again", cause = error)
        is SSLException -> ApiException(ApiFailure.TLS, "secure connection to $host failed: ${error.message}", cause = error)
        is IOException -> ApiException(ApiFailure.UNREACHABLE, "network error talking to $host: ${error.message}", cause = error)
        else -> ApiException(ApiFailure.UNREACHABLE, "request to $host failed: ${error.message}", cause = error)
    }

    private fun errorBody(text: String): Pair<String?, String?> {
        val obj = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null to null
        fun field(name: String) = (obj[name] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
        return field("error") to field("message")
    }

    private fun parse(text: String): JsonElement = try {
        json.parseToJsonElement(text)
    } catch (e: SerializationException) {
        throw protocolError("response is not JSON", e)
    }

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, text: String): T = try {
        json.decodeFromString(serializer, text)
    } catch (e: SerializationException) {
        throw protocolError("unexpected response", e)
    } catch (e: IllegalArgumentException) {
        throw protocolError("unexpected response", e)
    }

    private fun protocolError(what: String, cause: Throwable? = null) =
        ApiException(ApiFailure.PROTOCOL, "$host sent an $what; is web-url in config.yml a Kaizen editor?", cause = cause)
}
