package sample

import "sync"

func launch() {
	var workers sync.WaitGroup
	go func() {
		workers.Add(1)
		defer workers.Done()
	}()
	workers.Wait()
}
