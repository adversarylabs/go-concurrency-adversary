package sample

import "time"

func pulse() {
	ticker := time.NewTicker(time.Second)
	<-ticker.C
}

func tickForever() {
	c := time.Tick(time.Second)
	<-c
}
