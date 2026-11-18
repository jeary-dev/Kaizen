package dev.jeary.kaizen.core.apply

/** Lines added and removed between two texts, for the per-file apply summary. */
data class DiffStat(val added: Int, val removed: Int) {
    val changed: Boolean get() = added > 0 || removed > 0
}

object LineDiff {
    /** Above this edit distance we stop computing an exact diff and count line multisets instead. */
    private const val MAX_D = 4000

    fun stat(before: String, after: String): DiffStat {
        val a = lines(before)
        val b = lines(after)
        // Trim the common prefix and suffix first; most edits touch a few lines in a large file.
        var start = 0
        while (start < a.size && start < b.size && a[start] == b[start]) start++
        var endA = a.size
        var endB = b.size
        while (endA > start && endB > start && a[endA - 1] == b[endB - 1]) { endA--; endB-- }
        val x = a.subList(start, endA)
        val y = b.subList(start, endB)
        if (x.isEmpty() || y.isEmpty()) return DiffStat(added = y.size, removed = x.size)
        val lcs = myersLcs(x, y) ?: return multisetStat(x, y)
        return DiffStat(added = y.size - lcs, removed = x.size - lcs)
    }

    private fun lines(text: String): List<String> =
        if (text.isEmpty()) emptyList() else text.removeSuffix("\n").split('\n').map { it.removeSuffix("\r") }

    /** Length of the longest common subsequence via Myers' O(ND) algorithm, or null if D is too large. */
    private fun myersLcs(a: List<String>, b: List<String>): Int? {
        val n = a.size
        val m = b.size
        val max = minOf(n + m, MAX_D)
        val offset = max + 1
        val v = IntArray(2 * max + 3)
        for (d in 0..max) {
            var k = -d
            while (k <= d) {
                var x = if (k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1])) v[offset + k + 1] else v[offset + k - 1] + 1
                var y = x - k
                while (x < n && y < m && a[x] == b[y]) { x++; y++ }
                v[offset + k] = x
                if (x >= n && y >= m) return (n + m - d) / 2
                k += 2
            }
        }
        return null
    }

    private fun multisetStat(a: List<String>, b: List<String>): DiffStat {
        val counts = HashMap<String, Int>()
        for (line in a) counts.merge(line, 1, Int::plus)
        var common = 0
        for (line in b) {
            val c = counts[line] ?: 0
            if (c > 0) { counts[line] = c - 1; common++ }
        }
        return DiffStat(added = b.size - common, removed = a.size - common)
    }
}
