package excellent

import (
	"context"
	"sync"
)

func collect(ctx context.Context, inputs <-chan int) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case _, ok := <-inputs:
				if !ok {
					return
				}
			}
		}
	}()
	workers.Wait()
}

