package dev.jeary.kaizen.core.protocol

import dev.jeary.kaizen.core.crypto.SessionKeys
import dev.jeary.kaizen.core.encoding.Base64Url
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import java.nio.file.Files
import java.nio.file.Paths

/**
 * Live cross-language round trip, driven by `node protocol/tools/interop.mjs`.
 *
 * The browser implementation (WebCrypto plus CompressionStream, run by Vitest) writes envelopes
 * with random keys into the interop directory. This test opens them, then writes its own for the
 * TypeScript side to open. Unlike the fixed vectors, this exercises each side's real gzip and
 * real random IVs.
 */
@EnabledIfEnvironmentVariable(named = "KAIZEN_INTEROP_DIR", matches = ".+")
class InteropTest {
    private val dir = Paths.get(System.getenv("KAIZEN_INTEROP_DIR"))

    @Test
    fun `opens envelopes sealed by the browser implementation`() {
        val file = dir.resolve("ts.json")
        assertTrue(Files.isRegularFile(file), "run the TypeScript side first: $file")
        val cases = kotlinx.serialization.json.Json.parseToJsonElement(Files.readString(file)).jsonArray
        assertTrue(cases.isNotEmpty())
        for (element in cases) {
            val case = element.jsonObject
            val keys = SessionKeys(checkNotNull(Base64Url.decodeOrNull(case.str("key"))), case.str("sid"))
            val kind = checkNotNull(Kind.fromWire(case.str("kind")))
            val plaintext = EnvelopeCodec.open(keys, kind, Envelope.fromJson(case.getValue("envelope")))
            assertEquals(case.str("plaintext"), String(plaintext, Charsets.UTF_8))
        }
    }

    @Test
    fun `writes envelopes for the browser implementation`() {
        Files.createDirectories(dir)
        val samples = listOf(
            Kind.UPLOAD to "",
            Kind.UPLOAD to "{\"motd\":\"桜 — sakura\\r\\n\"}",
            Kind.CHANGES to "x".repeat(200_000),
            Kind.CHANGES to "tabs\tand\u0000nulls and emoji 🌸",
        )
        val cases = samples.mapIndexed { i, (kind, text) ->
            val keys = SessionKeys.generate()
            val rev = if (kind == Kind.UPLOAD) 0L else i.toLong()
            buildJsonObject {
                put("key", Base64Url.encode(keys.key))
                put("sid", keys.sid)
                put("kind", kind.wire)
                put("plaintext", text)
                put("envelope", EnvelopeCodec.seal(keys, kind, rev, text.toByteArray()).toJson())
            }
        }
        Files.writeString(dir.resolve("kt.json"), JsonArray(cases).toString())
    }
}
