package main

import "sync"

type batchProcessor struct {
	mu sync.Mutex
}

func (p *batchProcessor) Export(ctx interface{}) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// work
}

func (p *batchProcessor) ForceFlush() {
	p.mu.Lock()
	defer p.mu.Unlock()
	// flush
}

func (p *batchProcessor) Shutdown() {
	p.mu.Lock()
	defer p.mu.Unlock()
	// shutdown
}
