package sample

import "sync"

func locked(mu sync.Mutex) {
	mu.Lock()
	defer mu.Unlock()
}

func copyMutex() {
	var mu sync.Mutex
	mu2 := mu
	_ = mu2
}
