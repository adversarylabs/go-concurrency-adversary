package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

// Clean fixture: instrumented double using func fields so the proof (atomic + >1 check + error)
// is inside the Test func body while still representing the protected API calls.
type batchProcessor struct {
	Export     func(ctx interface{})
	ForceFlush func()
}

func TestOverlappingCalls(t *testing.T) {
	var active int32
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
}
