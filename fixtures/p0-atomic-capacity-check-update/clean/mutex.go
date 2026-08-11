package limiter

import (
	"sync"
	"sync/atomic"
)

type LockedLimiter struct {
	mu       sync.Mutex
	capacity uint64
	reserved atomic.Uint64
}

func (l *LockedLimiter) Reserve(amount uint64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.reserved.Load()+amount > l.capacity {
		return errLimit
	}
	l.reserved.Add(amount)
	return nil
}
