package good

import (
	"context"
	"time"
)

func waitForReady(parent context.Context, ready <-chan struct{}) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()

	select {
	case <-ready:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

