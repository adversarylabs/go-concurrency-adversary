package terrible

import (
	"context"
	"sync"
)

func run(parent context.Context) {
	ctx, _ := context.WithCancel(parent)
	_ = ctx

	var workers sync.WaitGroup
	go func() {
		workers.Add(1)
		defer workers.Done()
	}()
	workers.Wait()

	results := make(chan int)
	results <- 42
	<-results
}

