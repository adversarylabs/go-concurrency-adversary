package sample

import "sync"

type lifecycle struct{}

func (lifecycle) Done() {}

func deferred(skip bool) {
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		if skip {
			return
		}
		doWork()
	}()
	workers.Wait()
}

func deferredClosure(skip bool) {
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer func() { workers.Done() }()
		if skip {
			return
		}
		doWork()
	}()
	workers.Wait()
}

func directLoop() {
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		for range 2 {
			workers.Done()
		}
	}()
	workers.Wait()
}

func unrelated(skip bool) {
	var operation lifecycle
	go func() {
		if skip {
			return
		}
		operation.Done()
	}()
}

func bottomOnly() {
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		doWork()
		workers.Done()
	}()
	workers.Wait()
}

func doWork() {}
