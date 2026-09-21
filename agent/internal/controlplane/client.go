package controlplane

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	baseURL *url.URL
	http    *http.Client
}

func New(rawURL string) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, errors.New("control plane URL must be an absolute HTTP(S) URL")
	}
	return &Client{
		baseURL: parsed,
		http: &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func (c *Client) BaseURL() string {
	return c.baseURL.String()
}
