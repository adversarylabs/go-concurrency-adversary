package sample

import "sync"

func locked(mu *sync.Mutex) {
	mu.Lock()
	defer mu.Unlock()
}

func shareMutex() {
	var mu sync.Mutex
	mu2 := &mu
	mu2.Lock()
	mu2.Unlock()
}
