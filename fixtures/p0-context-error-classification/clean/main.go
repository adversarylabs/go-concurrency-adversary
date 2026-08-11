package sample

import (
	"context"
	"errors"
	"log"
)

func byContextState(ctx context.Context) error {
	err := handle(ctx)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		log.Printf("handler failed: %v", err)
	}
	return nil
}

func byWrappedError(ctx context.Context) error {
	err := handle(ctx)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		log.Printf("handler failed: %v", err)
	}
	return nil
}

func direct(ctx context.Context) error {
	err := handle(ctx)
	if err != nil {
		return err
	}
	return nil
}

func unrelated(ctx context.Context) error {
	err := handleWithoutContext()
	if err != nil {
		log.Printf("handler failed: %v", err)
	}
	return ctx.Err()
}

func handle(context.Context) error { return nil }

func handleWithoutContext() error { return nil }
