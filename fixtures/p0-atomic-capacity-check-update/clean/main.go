package limiter

import "sync/atomic"

type Limiter struct {
	max  uint64
	used atomic.Uint64
}

func (l *Limiter) Add(amount uint64) error {
	for {
		current := l.used.Load()
		if l.max > 0 && current+amount > l.max {
			return errLimit
		}
		if l.used.CompareAndSwap(current, current+amount) {
			return nil
		}
	}
}

var errLimit error
