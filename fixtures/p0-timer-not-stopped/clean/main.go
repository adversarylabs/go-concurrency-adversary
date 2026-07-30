package sample

import "time"

func poll(done <-chan struct{}) {
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case <-done:
			return
		case <-timer.C:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(time.Second)
		}
	}
}
