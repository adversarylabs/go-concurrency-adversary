package sample

import "time"

func pulse() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	<-ticker.C
}
