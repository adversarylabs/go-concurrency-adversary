package sample

import "sync"

func launch() {
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
	}()
	workers.Wait()
}
