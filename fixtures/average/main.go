package average

import (
	"context"
	"time"
)

func load(parent context.Context) context.Context {
	ctx, _ := context.WithTimeout(parent, 5*time.Second)
	return ctx
}

