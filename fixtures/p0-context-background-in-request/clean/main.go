package sample

import (
	"context"
	"time"
)

type client struct{}

func (client) Get(context.Context) error { return nil }

func probe(ctx context.Context, api client) error {
	probeCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	return api.Get(probeCtx)
}

func deliberatelyDetached(ctx context.Context, api client) error {
	detached := context.WithoutCancel(ctx)
	bounded, cancel := context.WithTimeout(detached, time.Second)
	defer cancel()
	return api.Get(bounded)
}

func processRoot(api client) error {
	return api.Get(context.Background())
}
