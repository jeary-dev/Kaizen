package dev.jeary.kaizen.core.protocol

import dev.jeary.kaizen.core.crypto.OwnerSecret
import dev.jeary.kaizen.core.crypto.SessionKeys
import dev.jeary.kaizen.core.encoding.Base64Url
import dev.jeary.kaizen.core.encoding.Hex
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.DynamicTest.dynamicTest
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.assertThrows

/** Runs every case in protocol/test-vectors/v1.json against the Kotlin implementation. */
class ProtocolVectorTest {

    private fun keys(key: String, sid: String) = SessionKeys(decode(key), sid)

    private fun decode(text: String) = checkNotNull(Base64Url.decodeOrNull(text)) { "bad base64 in vectors: $text" }

    private fun kind(wire: String) = checkNotNull(Kind.fromWire(wire)) { "bad kind in vectors: $wire" }

    @TestFactory
    fun base64url(): List<DynamicTest> {
        val group = Vectors.group("base64url")
        val valid = group.getValue("valid").jsonArray.map { it.jsonObject }.map { case ->
            dynamicTest("valid '${case.str("text")}'") {
                assertEquals(case.str("hex"), Hex.encode(decode(case.str("text"))))
                assertEquals(case.str("text"), Base64Url.encode(Hex.decode(case.str("hex"))))
            }
        }
        val invalid = group.getValue("invalid").strings().map { text ->
            dynamicTest("invalid '${text.replace("\n", "\\n")}'") { assertNull(Base64Url.decodeOrNull(text)) }
        }
        return valid + invalid
    }

    @TestFactory
    fun keySchedule() = Vectors.list("keySchedule").map { case ->
        dynamicTest("sid ${case.str("sid")}") {
            val keys = keys(case.str("key"), case.str("sid"))
            assertEquals(case.str("kUp"), Base64Url.encode(keys.up))
            assertEquals(case.str("kDown"), Base64Url.encode(keys.down))
            assertEquals(case.str("editToken"), Base64Url.encode(keys.editToken))
            assertEquals(case.str("editHash"), keys.editHash)
        }
    }

    @TestFactory
    fun ownerHash() = Vectors.list("ownerHash").map { case ->
        dynamicTest("sid ${case.str("sid")}") {
            val secret = checkNotNull(OwnerSecret.parse(case.str("ownerSecret")))
            assertEquals(case.str("ownerHash"), secret.hashFor(case.str("sid")))
            assertEquals(case.str("ownerSecret"), secret.bearer)
        }
    }

    @TestFactory
    fun sealMatchesVectors() = Vectors.list("envelopes").map { case ->
        dynamicTest(case.str("name")) {
            val kind = kind(case.str("kind"))
            val sealed = EnvelopeCodec.seal(
                keys(case.str("key"), case.str("sid")),
                kind,
                case.int("rev").toLong(),
                case.str("plaintext").toByteArray(),
                iv = decode(case.str("iv")),
                precompressed = decode(case.str("compressed")),
            )
            assertEquals(Envelope.fromJson(case.getValue("envelope")), sealed)
            assertEquals(case.getValue("envelope").jsonObject, sealed.toJson())
        }
    }

    @TestFactory
    fun openMatchesVectors() = Vectors.list("envelopes").map { case ->
        dynamicTest(case.str("name")) {
            val envelope = Envelope.parse(case.getValue("envelope").toString())
            val plaintext = EnvelopeCodec.open(
                keys(case.str("key"), case.str("sid")),
                kind(case.str("kind")),
                envelope,
            )
            assertEquals(case.str("plaintext"), String(plaintext, Charsets.UTF_8))
        }
    }

    @TestFactory
    fun rejections() = Vectors.list("rejections").map { case ->
        dynamicTest("${case.str("name")} -> ${case.str("reason")}") {
            val error = assertThrows<ProtocolException> {
                val envelope = Envelope.fromJson(case.getValue("envelope"))
                EnvelopeCodec.open(
                    keys(case.str("key"), case.str("expectedSid")),
                    kind(case.str("expectedKind")),
                    envelope,
                    maxPlaintextBytes = case.int("maxPlaintextBytes"),
                )
            }
            assertEquals(case.str("reason"), error.reason.wire, error.message)
        }
    }

    @TestFactory
    fun payloads() = Vectors.list("payloads").map { case ->
        dynamicTest(case.str("name")) {
            val bytes = case.str("json").toByteArray()
            val decode = {
                when (case.str("kind")) {
                    "upload" -> PayloadCodec.decodeUpload(bytes, case.str("sid"))
                    else -> PayloadCodec.decodeChanges(bytes, case.str("sid"))
                }
            }
            if ((case["ok"] as? JsonPrimitive)?.content == "true") {
                decode()
            } else {
                val error = assertThrows<ProtocolException> { decode() }
                assertEquals(case.str("reason"), error.reason.wire, error.message)
            }
        }
    }

    @TestFactory
    fun paths(): List<DynamicTest> {
        val group = Vectors.group("paths")
        return group.getValue("valid").strings().map { p -> dynamicTest("valid $p") { assertTrue(ProtocolPaths.isValid(p)) } } +
            group.getValue("invalid").strings().map { p ->
                dynamicTest("invalid ${ProtocolPaths.printable(p)}") { assertFalse(ProtocolPaths.isValid(p)) }
            }
    }

    @TestFactory
    fun applyCodes() = Vectors.list("applyCodes").map { case ->
        dynamicTest("'${case.str("input")}'") {
            val expected = case.getValue("normalized").jsonPrimitive.let { if (it is JsonNull) null else it.content }
            assertEquals(expected, ApplyCode.normalize(case.str("input")))
        }
    }

    @TestFactory
    fun reencodedPayloadsRoundTrip() = listOf("upload", "changes").map { kind ->
        dynamicTest(kind) {
            val case = Vectors.list("payloads").first { it.str("kind") == kind && (it["ok"] as? JsonPrimitive)?.content == "true" }
            val bytes = case.str("json").toByteArray()
            val sid = case.str("sid")
            if (kind == "upload") {
                val decoded = PayloadCodec.decodeUpload(bytes, sid)
                assertEquals(decoded, PayloadCodec.decodeUpload(PayloadCodec.encodeUpload(decoded), sid))
            } else {
                val decoded = PayloadCodec.decodeChanges(bytes, sid)
                assertEquals(decoded, PayloadCodec.decodeChanges(PayloadCodec.encodeChanges(decoded), sid))
            }
        }
    }

    @TestFactory
    fun applyCodeAlphabetIsCrockford() = listOf(dynamicTest("alphabet") {
        assertEquals(32, ApplyCode.ALPHABET.length)
        assertArrayEquals(ApplyCode.ALPHABET.toCharArray().distinct().toCharArray(), ApplyCode.ALPHABET.toCharArray())
        ApplyCode.ALPHABET.forEach { assertEquals(it.toString(), ApplyCode.normalize("$it".repeat(8))?.take(1)) }
    })
}
