package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
		http:    &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func (c *Client) BaseURL() string {
	return c.baseURL.String()
}

func (c *Client) PostJSON(
	ctx context.Context,
	path string,
	requestValue any,
	responseValue any,
) error {
	body, err := json.Marshal(requestValue)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: path})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("content-type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("perform request: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if err := json.Unmarshal(data, responseValue); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("control plane returned HTTP %d", resp.StatusCode)
	}
	return nil
}
