package dev.jeary.kaizen

import dev.jeary.kaizen.core.crypto.Randomness
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Pending "[Confirm] / [Cancel]" prompts. A token belongs to the sender who asked, expires after
 * two minutes, and can be used once. Each sender has at most one pending prompt.
 */
class Confirmations(private val ttl: Duration = Duration.ofMinutes(2)) {
    class Pending<T>(val owner: String, val value: T, val expiresAt: Instant)

    private val pending = ConcurrentHashMap<String, Pending<Any>>()

    fun <T : Any> put(owner: String, value: T, now: Instant = Instant.now()): String {
        pending.entries.removeIf { it.value.owner == owner }
        val token = Randomness.chars("abcdefghjkmnpqrstuvwxyz23456789", 6)
        pending[token] = Pending(owner, value, now.plus(ttl))
        return token
    }

    /** Takes the prompt if [token] exists, belongs to [owner] and hasn't expired; otherwise null. */
    inline fun <reified T : Any> take(owner: String, token: String, now: Instant = Instant.now()): T? {
        val entry = remove(owner, token, now) ?: return null
        return entry as? T
    }

    @PublishedApi
    internal fun remove(owner: String, token: String, now: Instant): Any? {
        val entry = pending[token] ?: return null
        if (entry.owner != owner) return null
        pending.remove(token)
        return if (entry.expiresAt.isAfter(now)) entry.value else null
    }

    fun prune(now: Instant) {
        pending.entries.removeIf { !it.value.expiresAt.isAfter(now) }
    }
}
