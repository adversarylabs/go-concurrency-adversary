package sample

func wait(done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		}
	}
}
