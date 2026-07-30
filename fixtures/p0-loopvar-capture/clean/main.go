package sample

func fanoutShadow(items []int) {
	for _, x := range items {
		x := x
		go func() {
			_ = x
		}()
	}
}

func fanoutParam(items []int) {
	for _, x := range items {
		go func(x int) {
			_ = x
		}(x)
	}
}
