package sample

import "sync"

func track(wg *sync.WaitGroup) {
	wg.Add(1)
	go func() {
		defer wg.Done()
	}()
	wg.Wait()
}
