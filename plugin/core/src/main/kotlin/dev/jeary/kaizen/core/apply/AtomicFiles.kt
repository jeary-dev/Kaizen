package dev.jeary.kaizen.core.apply

import dev.jeary.kaizen.core.crypto.Randomness
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions

/** Crash-safe file writes: write a temp file beside the target, fsync it, then rename over the target. */
object AtomicFiles {
    private val OWNER_ONLY = PosixFilePermissions.fromString("rw-------")

    fun write(target: Path, bytes: ByteArray, private: Boolean = false) {
        val dir = target.toAbsolutePath().parent ?: throw IOException("no parent folder for $target")
        val temp = dir.resolve(".${target.fileName}.kaizen-${Randomness.chars("abcdefghijklmnopqrstuvwxyz0123456789", 8)}.tmp")
        try {
            FileChannel.open(temp, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { channel ->
                val buffer = java.nio.ByteBuffer.wrap(bytes)
                while (buffer.hasRemaining()) channel.write(buffer)
                channel.force(true)
            }
            copyPermissions(target, temp, private)
            try {
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            Files.deleteIfExists(temp)
        }
    }

    /** Keeps the original file's POSIX permissions, or makes it owner-only when [private] is set. */
    private fun copyPermissions(original: Path, temp: Path, private: Boolean) {
        val posix = Files.getFileStore(temp).supportsFileAttributeView("posix")
        if (!posix) return
        val perms: Set<PosixFilePermission> = when {
            private -> OWNER_ONLY
            Files.exists(original, LinkOption.NOFOLLOW_LINKS) -> Files.getPosixFilePermissions(original, LinkOption.NOFOLLOW_LINKS)
            else -> return
        }
        Files.setPosixFilePermissions(temp, perms)
    }
}
