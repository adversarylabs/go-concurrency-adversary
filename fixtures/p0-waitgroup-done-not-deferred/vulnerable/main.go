package sample

import "sync"

func launch(skip bool) {
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		if skip {
			return
		}
		doWork()
		workers.Done()
	}()
	workers.Wait()
}

func doWork() {}

func fanOut(items []bool) {
	var workers sync.WaitGroup
	for _, skip := range items {
		workers.Add(1)
		go func(skip bool) {
			if skip {
				return
			}
			doWork()
			workers.Done()
		}(skip)
	}
	workers.Wait()
}
