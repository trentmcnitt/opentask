/*
 * Frozen-clock shim for the Apple Watch screenshots (docs/SCREENSHOTS.md).
 *
 * The watchOS simulator runs on the Mac's clock and `simctl status_bar`
 * doesn't support watchOS, so the watch app — and the time the system draws
 * in its corner — would show today's date and time against sample data
 * seeded for the pipeline's frozen "now". capture-watch-app.sh builds this
 * into a dylib and boots a throwaway simulator with it inserted into every
 * simulator process (`SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`), so the app and
 * the system clock agree.
 *
 * It is never linked into, or shipped with, any app: it is built on the fly
 * into the run's derived-data directory and exists only for that simulator.
 * The watch app has no clock hook of its own.
 *
 *   OPENTASK_FAKE_NOW   the wall clock to report, Unix seconds (unset: the
 *                       shim does nothing)
 *   OPENTASK_FAKE_FROM  the real Unix time that "now" corresponds to; time
 *                       then moves on from there. Unset: the clock stays
 *                       frozen at OPENTASK_FAKE_NOW.
 *
 * Only the wall clock (CLOCK_REALTIME, gettimeofday, time) changes;
 * monotonic clocks are untouched, so timers, animations and timeouts behave.
 * dyld's __interpose applies to every image in the process, so Foundation's
 * Date() reads the fake time too.
 */
#include <stdint.h>
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

static int active = 0;
static int frozen = 0;
static int64_t target_ns = 0;
static int64_t offset_ns = 0;

__attribute__((constructor)) static void init(void) {
  const char *target = getenv("OPENTASK_FAKE_NOW");
  if (!target) return;
  active = 1;
  target_ns = (int64_t)(atof(target) * 1e9);
  const char *from = getenv("OPENTASK_FAKE_FROM");
  if (from) {
    offset_ns = target_ns - (int64_t)(atof(from) * 1e9);
  } else {
    frozen = 1;
  }
}

static int64_t fake_ns(int64_t real_ns) { return frozen ? target_ns : real_ns + offset_ns; }

static int fake_gettimeofday(struct timeval *tv, void *tz) {
  int r = gettimeofday(tv, tz);
  if (r == 0 && tv && active) {
    int64_t ns = fake_ns((int64_t)tv->tv_sec * 1000000000LL + (int64_t)tv->tv_usec * 1000);
    tv->tv_sec = (time_t)(ns / 1000000000LL);
    tv->tv_usec = (suseconds_t)((ns % 1000000000LL) / 1000);
  }
  return r;
}

static int fake_clock_gettime(clockid_t clock, struct timespec *ts) {
  int r = clock_gettime(clock, ts);
  if (r == 0 && ts && active && clock == CLOCK_REALTIME) {
    int64_t ns = fake_ns((int64_t)ts->tv_sec * 1000000000LL + ts->tv_nsec);
    ts->tv_sec = (time_t)(ns / 1000000000LL);
    ts->tv_nsec = (long)(ns % 1000000000LL);
  }
  return r;
}

static uint64_t fake_clock_gettime_nsec_np(clockid_t clock) {
  uint64_t v = clock_gettime_nsec_np(clock);
  return (active && clock == CLOCK_REALTIME) ? (uint64_t)fake_ns((int64_t)v) : v;
}

static time_t fake_time(time_t *out) {
  struct timespec ts;
  fake_clock_gettime(CLOCK_REALTIME, &ts);
  if (out) *out = ts.tv_sec;
  return ts.tv_sec;
}

#define INTERPOSE(replacement, original)                                    \
  __attribute__((used)) static struct {                                     \
    const void *replacement;                                                \
    const void *original;                                                   \
  } interpose_##original __attribute__((section("__DATA,__interpose"))) = { \
      (const void *)&replacement, (const void *)&original};

INTERPOSE(fake_gettimeofday, gettimeofday)
INTERPOSE(fake_clock_gettime, clock_gettime)
INTERPOSE(fake_clock_gettime_nsec_np, clock_gettime_nsec_np)
INTERPOSE(fake_time, time)
