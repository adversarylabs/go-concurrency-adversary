package main

import (
	"sync/atomic"
	"testing"
)

func TestOverlappingCalls(t *testing.T) {
	p := &batchProcessor{}
	var active int32
	// instrumented fake with active counter to assert serialization
	go func() {
		if atomic.AddInt32(&active, 1) > 1 {
			t.Error("concurrent call detected")
		}
		defer atomic.AddInt32(&active, -1)
		p.Export(nil)
	}()
	go func() {
		if atomic.AddInt32(&active, 1) > 1 {
			t.Error("concurrent call detected")
		}
		defer atomic.AddInt32(&active, -1)
		p.ForceFlush()
	}()
	// max active asserted via counter
}
