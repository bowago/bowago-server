"use client";

import { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { useSelector } from "react-redux";
import { RootState } from "@/store/store";
import {
  useInitiateShipmentPaymentMutation,
  useMarkAsPaidMutation,
  useWaivePaymentMutation,
} from "@/store/slice/apiSlice";
import CancelShipmentModal from "@/components/modals/CancelShipmentModal";
import ViewShipmentModal from "@/components/modals/ViewShipmentModal";

// ─── Status badge ─────────────────────────────────────────────────────────────
const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  PENDING:              { label: "Pending",         className: "bg-yellow-100 text-yellow-700" },
  CONFIRMED:            { label: "Confirmed",        className: "bg-blue-100 text-blue-700" },
  PICKED_UP:            { label: "Picked Up",        className: "bg-indigo-100 text-indigo-700" },
  IN_TRANSIT:           { label: "In Transit",       className: "bg-purple-100 text-purple-700" },
  OUT_FOR_DELIVERY:     { label: "Out for Delivery", className: "bg-orange-100 text-orange-700" },
  DELIVERED:            { label: "Delivered",        className: "bg-green-100 text-green-700" },
  FAILED:               { label: "Failed",           className: "bg-red-100 text-red-700" },
  CANCELLED:            { label: "Cancelled",        className: "bg-gray-200 text-gray-600" },
  RETURNED:             { label: "Returned",         className: "bg-pink-100 text-pink-700" },
  PENDING_ADMIN_REVIEW: { label: "Admin Review",     className: "bg-gray-100 text-gray-500" },
};

// ─── Types ───────────────────────────────────────────────────────────────────
export type Shipment = {
  id: string;
  trackingNumber: string;
  senderName: string;
  senderCity: string;
  senderPhone: string;
  recipientName: string;
  recipientPhone: string;
  recipientCity: string;
  status: string;
  paymentStatus?: string;
  finalPrice?: number;
  quotedPrice?: number;
  pickupDate: string;
};

// ─── Mark as Paid modal (admin only) ─────────────────────────────────────────
function MarkAsPaidModal({
  shipmentId,
  isSuperAdmin,
  onClose,
}: {
  shipmentId: string;
  isSuperAdmin: boolean;
  onClose: () => void;
}) {
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"manual" | "waive">("manual");
  const [markAsPaid, { isLoading: marking }] = useMarkAsPaidMutation();
  const [waivePayment, { isLoading: waiving }] = useWaivePaymentMutation();

  const handleSubmit = async () => {
    if (mode === "waive") {
      await waivePayment({ shipmentId, reason }).unwrap();
    } else {
      await markAsPaid({ shipmentId, method, reference, notes }).unwrap();
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 m-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Record Payment</h2>
        <p className="text-sm text-gray-500 mb-4">
          Use this to record cash, bank transfer, or POS payments made outside Paystack.
        </p>

        {isSuperAdmin && (
          <div className="flex rounded-xl overflow-hidden border border-gray-200 mb-4">
            <button
              onClick={() => setMode("manual")}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${mode === "manual" ? "bg-brand text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
            >
              Mark as Paid
            </button>
            <button
              onClick={() => setMode("waive")}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${mode === "waive" ? "bg-brand text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
            >
              Waive Payment
            </button>
          </div>
        )}

        {mode === "manual" ? (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Payment Method</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm"
              >
                <option value="cash">Cash</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="pos">POS Terminal</option>
                <option value="cheque">Cheque</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Reference / Receipt No. <span className="text-gray-400">(optional)</span>
              </label>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. TRF-20260619-001"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Notes <span className="text-gray-400">(optional)</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Any additional notes..."
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none"
              />
            </div>
          </div>
        ) : (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Reason for waiver <span className="text-gray-400">(optional)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Goodwill gesture for long-term customer"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none"
            />
            <p className="text-xs text-orange-600 mt-2">
              ⚠ Waiving sets the final price to ₦0 and marks the shipment as paid.
            </p>
          </div>
        )}

        <div className="flex gap-3 mt-5">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={marking || waiving}
            className="flex-1 px-4 py-2 bg-brand hover:bg-red-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50"
          >
            {marking || waiving ? "Saving..." : mode === "waive" ? "Waive Payment" : "Mark as Paid"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Action cell ──────────────────────────────────────────────────────────────
function ShipmentActionCell({ shipment }: { shipment: Shipment }) {
  const [openViewModal, setOpenViewModal] = useState(false);
  const [openCancelModal, setOpenCancelModal] = useState(false);
  const [openMarkPaidModal, setOpenMarkPaidModal] = useState(false);

  const user = useSelector((s: RootState) => s.auth.user) as any;
  const isAdmin = user?.role === "ADMIN";
  const isSuperAdmin = user?.adminSubRole === "SUPER_ADMIN";

  const [initPayment, { isLoading: paying }] = useInitiateShipmentPaymentMutation();

  const isPaid = shipment.paymentStatus === "PAID";
  const isTerminal = ["DELIVERED", "CANCELLED", "RETURNED"].includes(shipment.status);

  const handlePay = async () => {
    try {
      const callbackUrl = `${window.location.origin}/dashboard/payment/callback`;
      const result = await initPayment({ shipmentId: shipment.id, callbackUrl }).unwrap();
      const url = (result as any)?.authorizationUrl ?? (result as any)?.data?.authorizationUrl;
      if (url) window.location.href = url;
    } catch {}
  };

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {/* CUSTOMER: Pay button */}
        {!isAdmin && !isPaid && (
          <button
            onClick={handlePay}
            disabled={paying}
            className="bg-brand hover:bg-red-700 text-white px-2.5 py-1 rounded-md text-xs font-semibold disabled:opacity-50 transition-colors"
          >
            {paying ? "..." : "Pay"}
          </button>
        )}

        {/* ADMIN: Mark as Paid button (only if not already paid) */}
        {isAdmin && !isPaid && (
          <button
            onClick={() => setOpenMarkPaidModal(true)}
            className="bg-green-600 hover:bg-green-700 text-white px-2.5 py-1 rounded-md text-xs font-semibold transition-colors"
          >
            Mark Paid
          </button>
        )}

        {/* Paid badge (admin view) */}
        {isAdmin && isPaid && (
          <span className="bg-green-100 text-green-700 px-2.5 py-1 rounded-md text-xs font-medium">
            ✓ Paid
          </span>
        )}

        {/* View */}
        <button
          onClick={() => setOpenViewModal(true)}
          className="text-blue-500 border border-blue-400 px-2.5 py-1 rounded-md text-xs hover:bg-blue-50 transition-colors"
        >
          View
        </button>

        {/* Cancel */}
        {!isTerminal && (
          <button
            onClick={() => setOpenCancelModal(true)}
            className="text-red-500 border border-red-400 px-2.5 py-1 rounded-md text-xs hover:bg-red-50 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>

      {openViewModal && (
        <ViewShipmentModal isOpen={openViewModal} setIsOpen={setOpenViewModal} id={shipment.id} />
      )}
      {openCancelModal && (
        <CancelShipmentModal isOpen={openCancelModal} setIsOpen={setOpenCancelModal} id={shipment.id} />
      )}
      {openMarkPaidModal && (
        <MarkAsPaidModal
          shipmentId={shipment.id}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setOpenMarkPaidModal(false)}
        />
      )}
    </>
  );
}

// ─── Column definitions ───────────────────────────────────────────────────────
export const ShipmentColumns: ColumnDef<Shipment>[] = [
  {
    header: "S/N",
    cell: ({ row }) => <div className="text-gray-500">{row.index + 1}</div>,
  },
  {
    accessorKey: "trackingNumber",
    header: "Tracking No",
    cell: ({ row }) => (
      <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded">
        {row.getValue<string>("trackingNumber")}
      </span>
    ),
  },
  {
    id: "sender",
    header: "Sender",
    cell: ({ row }) => {
      const { senderName, senderPhone, senderCity } = row.original;
      return (
        <div className="text-sm">
          <p className="font-medium">{senderName}</p>
          <p className="text-gray-400 text-xs">{senderPhone} · {senderCity}</p>
        </div>
      );
    },
  },
  {
    id: "recipient",
    header: "Recipient",
    cell: ({ row }) => {
      const { recipientName, recipientPhone, recipientCity } = row.original;
      return (
        <div className="text-sm">
          <p className="font-medium">{recipientName}</p>
          <p className="text-gray-400 text-xs">{recipientPhone} · {recipientCity}</p>
        </div>
      );
    },
  },
  {
    id: "price",
    header: "Price",
    cell: ({ row }) => {
      const price = row.original.quotedPrice ?? row.original.finalPrice ?? 0;
      const ps = row.original.paymentStatus;
      return (
        <div className="text-sm">
          <p className="font-semibold">₦{price.toLocaleString()}</p>
          {ps && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              ps === "PAID"    ? "bg-green-100 text-green-700"
              : ps === "PENDING" ? "bg-yellow-100 text-yellow-700"
              : "bg-gray-100 text-gray-500"
            }`}>
              {ps.toLowerCase()}
            </span>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const status = row.getValue<string>("status");
      const config = STATUS_STYLES[status] ?? { label: status, className: "bg-gray-100 text-gray-500" };
      return (
        <span className={`px-2 py-1 text-xs rounded-full font-medium ${config.className}`}>
          {config.label}
        </span>
      );
    },
  },
  {
    accessorKey: "pickupDate",
    header: "Pickup Date",
    cell: ({ row }) => {
      const d = row.getValue<string>("pickupDate");
      if (!d) return <span className="text-gray-400 text-xs">—</span>;
      return <div className="text-xs text-gray-600">{new Date(d).toLocaleDateString()}</div>;
    },
  },
  {
    id: "action",
    header: "Action",
    cell: ({ row }) => <ShipmentActionCell shipment={row.original} />,
  },
];
