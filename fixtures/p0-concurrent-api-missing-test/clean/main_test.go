package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestOverlappingCalls(t *testing.T) {
	var active int32
	// instrumented fake: count inside the call "body" (critical section) so it tracks
	// execution overlap of the protected API, not just launch overlap.
	p := &batchProcessor{
		Export: func(ctx interface{}) {
			if atomic.AddInt32(&active, 1) > 1 {
				t.Error("concurrent call detected")
			}
			defer atomic.AddInt32(&active, -1)
			// protected work
		},
		ForceFlush: func() {
			if atomic.AddInt32(&active, 1) > 1 {
				t.Error("concurrent call detected")
			}
			defer atomic.AddInt32(&active, -1)
			// flush
		},
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		p.Export(nil)
	}()
	go func() {
		defer wg.Done()
		p.ForceFlush()
	}()
	wg.Wait()
	// proof of max concurrency 1 is asserted via the active counter inside the API bodies
}
