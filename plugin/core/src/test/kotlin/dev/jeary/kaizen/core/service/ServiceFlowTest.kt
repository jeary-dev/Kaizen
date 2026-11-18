package dev.jeary.kaizen.core.service

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.jeary.kaizen.core.apply.ApplyTransaction
import dev.jeary.kaizen.core.apply.BackupStore
import dev.jeary.kaizen.core.crypto.Digests
import dev.jeary.kaizen.core.crypto.OwnerSecret
import dev.jeary.kaizen.core.crypto.SessionKeys
import dev.jeary.kaizen.core.encoding.Base64Url
import dev.jeary.kaizen.core.files.ConfigCollector
import dev.jeary.kaizen.core.files.FilePolicy
import dev.jeary.kaizen.core.files.PathGuard
import dev.jeary.kaizen.core.files.Scope
import dev.jeary.kaizen.core.http.ApiException
import dev.jeary.kaizen.core.http.ApiFailure
import dev.jeary.kaizen.core.http.KaizenApi
import dev.jeary.kaizen.core.protocol.ChangedFile
import dev.jeary.kaizen.core.protocol.ChangesPayload
import dev.jeary.kaizen.core.protocol.Envelope
import dev.jeary.kaizen.core.protocol.EnvelopeCodec
import dev.jeary.kaizen.core.protocol.Kind
import dev.jeary.kaizen.core.protocol.PayloadCodec
import dev.jeary.kaizen.core.protocol.ServerInfo
import dev.jeary.kaizen.core.redaction.RedactionRules
import dev.jeary.kaizen.core.session.SessionRecord
import dev.jeary.kaizen.core.session.SessionStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

/**
 * Plugin services against a minimal in-process editor server. The "browser" here is Kotlin
 * code using the same protocol primitives the web app uses.
 */
class ServiceFlowTest {
    @TempDir
    lateinit var root: Path

    private lateinit var server: HttpServer
    private val uploads = mutableMapOf<String, JsonObject>()
    private val ownerHashes = mutableMapOf<String, String>()
    private val changesByCode = mutableMapOf<String, Pair<String, JsonObject?>>()
    private var applied = mutableListOf<String>()

    private val clock = Clock.fixed(Instant.parse("2026-11-18T13:00:00Z"), ZoneOffset.UTC)
    private val owner = OwnerSecret.generate()
    private val rules = RedactionRules()

    private lateinit var api: KaizenApi
    private lateinit var sessions: SessionStore
    private lateinit var editor: EditorService
    private lateinit var applier: ApplyService
    private lateinit var backups: BackupStore

    private fun reply(ex: HttpExchange, status: Int, body: String = "") {
        val bytes = body.toByteArray()
        ex.responseHeaders.add("Content-Type", "application/json")
        ex.sendResponseHeaders(status, if (status == 204) -1 else bytes.size.toLong())
        if (status != 204) ex.responseBody.use { it.write(bytes) }
        ex.close()
    }

    @BeforeEach
    fun setUp() {
        Files.createDirectories(root.resolve("plugins/Shop"))
        Files.writeString(root.resolve("plugins/Shop/config.yml"), "# Shop\r\nprice: 10\r\ndatabase:\r\n  password: \"hunter2\"\r\n")
        Files.writeString(root.resolve("server.properties"), "motd=hello\nrcon.password=rcon-secret\n")

        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/v1/info") { reply(it, 200, """{"name":"kaizen","protocols":[1],"ttl":{"min":60,"default":3600,"max":21600},"limits":{"uploadBytes":8388608,"changesBytes":8388608}}""") }
        server.createContext("/api/v1/sessions") { ex ->
            val path = ex.requestURI.path
            when {
                path == "/api/v1/sessions" -> {
                    val body = Json.parseToJsonElement(ex.requestBody.readAllBytes().decodeToString()).jsonObject
                    val envelope = body.getValue("envelope").jsonObject
                    val sid = envelope.getValue("sid").jsonPrimitive.content
                    uploads[sid] = envelope
                    ownerHashes[sid] = body.getValue("ownerHash").jsonPrimitive.content
                    reply(ex, 201, """{"sid":"$sid","expiresAt":"2026-11-18T14:00:00Z","ttlSeconds":3600}""")
                }
                path.endsWith("/applied") -> { applied += path.split('/')[4]; reply(ex, 204) }
                else -> reply(ex, 404, """{"error":"not_found","message":"nope"}""")
            }
        }
        server.createContext("/api/v1/claim") { ex ->
            val token = ex.requestHeaders.getFirst("Authorization").removePrefix("Bearer ")
            val code = Json.parseToJsonElement(ex.requestBody.readAllBytes().decodeToString()).jsonObject.getValue("code").jsonPrimitive.content
            val entry = changesByCode[code]
            val secret = OwnerSecret.parse(token)
            when {
                entry == null || secret == null || ownerHashes[entry.first] != secret.hashFor(entry.first) ->
                    reply(ex, 404, """{"error":"not_found","message":"no pending changes for this code"}""")
                entry.second == null -> reply(ex, 410, """{"error":"used","message":"this apply code has already been used"}""")
                else -> {
                    changesByCode[code] = entry.first to null
                    reply(ex, 200, """{"sid":"${entry.first}","envelope":${entry.second}}""")
                }
            }
        }
        server.start()

        val guard = PathGuard(root, FilePolicy())
        api = KaizenApi("http://127.0.0.1:${server.address.port}", "Kaizen-Test")
        sessions = SessionStore(root.resolve("plugins/Kaizen/data/sessions"))
        backups = BackupStore(root.resolve("plugins/Kaizen/backups"))
        editor = EditorService(ConfigCollector(guard), api, sessions, owner, "https://edit.example", clock)
        applier = ApplyService(api, sessions, owner, guard, ApplyTransaction(backups), clock)
    }

    @AfterEach
    fun tearDown() = server.stop(0)

    /** What the browser does: decrypt with K from the fragment, edit, encrypt with kDown, get a code. */
    private fun browserEdits(link: String, code: String, edit: (String, String) -> String?) {
        val sid = link.substringAfter("/e/").substringBefore("#")
        val keys = SessionKeys(checkNotNull(Base64Url.decodeOrNull(link.substringAfter("#k="))), sid)
        val plaintext = EnvelopeCodec.open(keys, Kind.UPLOAD, Envelope.fromJson(uploads.getValue(sid)))
        val upload = PayloadCodec.decodeUpload(plaintext, sid)
        val changed = upload.files.mapNotNull { f -> edit(f.path, f.content)?.let { ChangedFile(f.path, f.sha256, it) } }
        val changes = ChangesPayload(sid = sid, uploadSha256 = Digests.sha256Hex(plaintext), createdAt = clock.instant().toString(), files = changed)
        val sealed = EnvelopeCodec.seal(keys, Kind.CHANGES, 1, PayloadCodec.encodeChanges(changes))
        changesByCode[code] = sid to sealed.toJson()
    }

    private val serverInfo = ServerInfo("Paper 1.21.11", "1.0.0")

    @Test
    fun `open, edit in the browser, apply - secrets never leave and come back intact`() = runBlocking {
        val opened = editor.open(Scope.All, 3600, rules, mapOf("Shop" to "shop reload"), serverInfo, "console")
        assertTrue(opened.link.startsWith("https://edit.example/e/${opened.sid}#k="))
        assertEquals(2, opened.fileCount)
        assertEquals(2, opened.secretCount)

        // The server only ever saw ciphertext: no secret, no key, no plaintext config.
        val stored = uploads.getValue(opened.sid).toString()
        for (s in listOf("hunter2", "rcon-secret", "price", opened.link.substringAfter("#k="))) assertFalse(stored.contains(s))

        browserEdits(opened.link, "K7M2QX9P") { path, content ->
            assertFalse(content.contains("hunter2") || content.contains("rcon-secret"), "secret reached the browser")
            if (path == "plugins/Shop/config.yml") content.replace("price: 10", "price: 25") else null
        }

        val prepared = applier.prepare("k7m2-qx9p", rules)
        val planned = prepared.plan.files.single()
        assertEquals("plugins/Shop/config.yml", planned.path)
        assertEquals(1, planned.stat.added)
        assertEquals(1, planned.stat.removed)

        val manifest = applier.commit(prepared, "console")
        assertEquals(
            "# Shop\r\nprice: 25\r\ndatabase:\r\n  password: \"hunter2\"\r\n",
            Files.readString(root.resolve("plugins/Shop/config.yml")),
        )
        assertEquals("motd=hello\nrcon.password=rcon-secret\n", Files.readString(root.resolve("server.properties")))
        assertEquals(listOf(manifest.id), backups.list().map { it.id })
        assertEquals(listOf(opened.sid), applied)
        val record = sessions.load(opened.sid)
        assertEquals(SessionRecord.Status.APPLIED, record?.status)
        assertEquals(null, record?.key)

        // The code is spent.
        val reused = assertThrows<ApiException> { runBlocking { applier.prepare("K7M2QX9P", rules) } }
        assertEquals(410, reused.status)
    }

    @Test
    fun `changes for another server's session are refused`() = runBlocking {
        val opened = editor.open(Scope.Plugin("Shop"), 3600, rules, emptyMap(), serverInfo, "console")
        browserEdits(opened.link, "ABCDEFGH") { _, c -> c.replace("10", "11") }
        val stranger = ApplyService(api, sessions, OwnerSecret.generate(), PathGuard(root, FilePolicy()), ApplyTransaction(backups), clock)
        val e = assertThrows<ApiException> { runBlocking { stranger.prepare("ABCDEFGH", rules) } }
        assertEquals(404, e.status)
    }

    @Test
    fun `expired sessions are refused locally even if the server hands the changes over`() = runBlocking {
        val opened = editor.open(Scope.Plugin("Shop"), 3600, rules, emptyMap(), serverInfo, "console")
        browserEdits(opened.link, "ABCDEFGH") { _, c -> c.replace("10", "11") }
        val later = ApplyService(api, sessions, owner, PathGuard(root, FilePolicy()), ApplyTransaction(backups), Clock.offset(clock, java.time.Duration.ofHours(2)))
        val e = assertThrows<KaizenException> { runBlocking { later.prepare("ABCDEFGH", rules) } }
        assertEquals("apply.expired", e.key)
    }

    @Test
    fun `bad codes never reach the network`() = runBlocking {
        val e = assertThrows<KaizenException> { runBlocking { applier.prepare("K7M2,QX9P", rules) } }
        assertEquals("apply.bad-code", e.key)
    }

    @Test
    fun `a blocked host gives a clear message`() = runBlocking {
        val closedPort = ServerSocket(0).use { it.localPort }
        val dead = KaizenApi("http://127.0.0.1:$closedPort", "Kaizen-Test")
        val e = assertThrows<ApiException> { runBlocking { dead.info() } }
        assertEquals(ApiFailure.UNREACHABLE, e.failure)
        assertTrue(e.message?.contains("block outbound") == true, e.message)
    }

    @Test
    fun `a URL that is not a Kaizen server is reported as such`() = runBlocking {
        server.createContext("/not-kaizen/api/v1/info") { reply(it, 200, "<html>hello</html>") }
        val wrong = KaizenApi("http://127.0.0.1:${server.address.port}/not-kaizen", "Kaizen-Test")
        val e = assertThrows<ApiException> { runBlocking { wrong.info() } }
        assertEquals(ApiFailure.PROTOCOL, e.failure)
    }
}
