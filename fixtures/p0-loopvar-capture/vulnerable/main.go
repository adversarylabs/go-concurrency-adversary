package sample

func fanout(items []int) {
	for _, x := range items {
		go func() {
			_ = x
		}()
	}
}
