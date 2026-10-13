package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	mode := env("JOOD_MODE", "observer")
	var err error
	switch mode {
	case "node":
		err = runNode(ctx)
	case "observer":
		err = runObserver(ctx)
	default:
		err = errors.New("JOOD_MODE must be node or observer")
	}
	if err != nil {
		log.Fatal(err)
	}
}
func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
func secureClient(caFile string) (*http.Client, error) {
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if caFile != "" {
		b, err := os.ReadFile(caFile)
		if err != nil {
			return nil, err
		}
		if !pool.AppendCertsFromPEM(b) {
			return nil, errors.New("invalid observer CA")
		}
	}
	return &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}, MaxIdleConns: 8, IdleConnTimeout: 60 * time.Second}}, nil
}
