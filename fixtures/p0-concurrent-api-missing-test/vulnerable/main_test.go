package main

import "testing"

func TestOverlappingCalls(t *testing.T) {
	p := &batchProcessor{}
	// races the methods; no counter to detect concurrent execution
	go p.Export(nil)
	go p.ForceFlush()
	go p.Shutdown()
	// no instrumentation; would pass even if overlapping
}
