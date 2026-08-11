package limiter

import "sync/atomic"

type Limiter struct {
	max  uint64
	used atomic.Uint64
}

func (l *Limiter) Current() uint64 {
	return l.used.Load()
}

func (l *Limiter) Add(amount uint64) error {
	if l.max > 0 && l.Current()+amount > l.max {
		return errLimit
	}
	l.used.Add(amount)
	return nil
}

var errLimit error
