package dev.jeary.kaizen.core.crypto

import dev.jeary.kaizen.core.encoding.Hex
import dev.jeary.kaizen.core.protocol.Envelope
import dev.jeary.kaizen.core.protocol.EnvelopeCodec
import dev.jeary.kaizen.core.protocol.Kind
import dev.jeary.kaizen.core.protocol.ProtocolException
import dev.jeary.kaizen.core.protocol.Reason
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class CryptoTest {

    @Test
    fun `hkdf matches RFC 5869 test case 1`() {
        val okm = Digests.hkdfSha256(
            ikm = Hex.decode("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
            salt = Hex.decode("000102030405060708090a0b0c"),
            info = Hex.decode("f0f1f2f3f4f5f6f7f8f9"),
            length = 42,
        )
        assertEquals(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
            Hex.encode(okm),
        )
    }

    @Test
    fun `subkeys are distinct and bound to the session id`() {
        val a = SessionKeys.generate()
        val b = SessionKeys(a.key, SessionId.generate())
        assertFalse(a.up.contentEquals(a.down))
        assertFalse(a.up.contentEquals(a.editToken))
        assertFalse(a.up.contentEquals(b.up), "same K under another sid must give different subkeys")
        assertTrue(SessionId.isValid(a.sid))
        assertEquals(43, a.fragmentKey.length)
    }

    @Test
    fun `random round trip, both directions, many sizes`() {
        val keys = SessionKeys.generate()
        for (size in listOf(0, 1, 15, 16, 17, 4096, 300_000)) {
            val plaintext = ByteArray(size) { ('a'.code + it % 26).toByte() }
            for ((kind, rev) in listOf(Kind.UPLOAD to 0L, Kind.CHANGES to 7L)) {
                val sealed = EnvelopeCodec.seal(keys, kind, rev, plaintext)
                val reparsed = Envelope.parse(sealed.encode())
                assertArrayEquals(plaintext, EnvelopeCodec.open(keys, kind, reparsed))
            }
        }
    }

    @Test
    fun `every seal uses a fresh IV`() {
        val keys = SessionKeys.generate()
        val ivs = (1..200).map { Hex.encode(EnvelopeCodec.seal(keys, Kind.UPLOAD, 0, byteArrayOf(1)).iv) }
        assertEquals(ivs.size, ivs.toSet().size)
    }

    @Test
    fun `every single-bit flip of the ciphertext is rejected`() {
        val keys = SessionKeys.generate()
        val sealed = EnvelopeCodec.seal(keys, Kind.CHANGES, 1, "petals: 256".toByteArray())
        for (i in sealed.ct.indices) {
            for (bit in 0 until 8) {
                val ct = sealed.ct.copyOf().also { it[i] = (it[i].toInt() xor (1 shl bit)).toByte() }
                val error = assertThrows<ProtocolException> {
                    EnvelopeCodec.open(keys, Kind.CHANGES, sealed.copy(ct = ct))
                }
                assertEquals(Reason.AUTH, error.reason)
            }
        }
    }

    @Test
    fun `owner hashes are unlinkable across sessions and verify in constant time`() {
        val owner = OwnerSecret.generate()
        val h1 = owner.hashFor(SessionId.generate())
        val h2 = owner.hashFor(SessionId.generate())
        assertNotEquals(h1, h2)
        assertTrue(Hex.isSha256(h1))
        assertTrue(Digests.constantTimeEquals(Hex.decode(h1), Hex.decode(h1)))
        assertNull(OwnerSecret.parse("too-short"))
        assertEquals(owner.bearer, OwnerSecret.parse(owner.bearer)?.bearer)
    }
}
