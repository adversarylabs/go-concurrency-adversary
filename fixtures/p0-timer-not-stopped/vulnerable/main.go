package sample

import "time"

func poll(done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		case <-time.After(time.Second):
		}
	}
}
