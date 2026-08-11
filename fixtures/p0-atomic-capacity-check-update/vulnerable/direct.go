package limiter

import "sync/atomic"

type DirectLimiter struct {
	capacity uint64
	reserved atomic.Uint64
}

func (l *DirectLimiter) Reserve(amount uint64) error {
	if l.reserved.Load()+amount > l.capacity {
		return errLimit
	}
	l.reserved.Add(amount)
	return nil
}
