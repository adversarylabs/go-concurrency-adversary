package sample

import (
	cx "context"
	"time"
)

type client struct{}

func (client) Get(cx.Context) error { return nil }

func probe(ctx cx.Context, api client) error {
	probeCtx, cancel := cx.WithTimeout(cx.Background(), time.Second)
	defer cancel()
	return api.Get(probeCtx)
}

func poll(register func(func(cx.Context) error), api client) {
	register(func(iteration cx.Context) error {
		return api.Get(cx.TODO())
	})
}
