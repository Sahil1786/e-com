function summarizeAnalyticsEvents(events) {
  const totals = {};
  const daily = {};

  const transactions = events.map((event) => {
    // Group by date (YYYY-MM-DD)
    const dateStr = new Date(event.createdAt).toISOString().split("T")[0];

    if (!daily[dateStr]) {
      daily[dateStr] = { count: 0 };
    }
    if (!totals[event.type]) {
      totals[event.type] = 0;
    }

    totals[event.type]++;
    daily[dateStr].count++;

    // Format the transaction for the frontend table
    return {
      ...event,
      // Fallback to the nested order object if the event itself is missing payment details
      paymentMethod: event.paymentMethod || event.order?.paymentMethod || null,
      paymentInstrument: event.paymentInstrument || event.order?.paymentInstrument || null,
    };
  });

  return {
    totals,
    daily,
    transactions,
  };
}

module.exports = { summarizeAnalyticsEvents };